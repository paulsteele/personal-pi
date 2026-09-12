import { join } from "node:path";
import {
	getAgentDir,
	getPackageDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.js";
import { resolveRepo, parseScope } from "./git.js";
import { installedPlannotator, present } from "./plannotator.js";
import { loadProfile } from "./profile.js";
import { loadPrompts } from "./prompts.js";
import { saveReport } from "./report.js";
import { displayOutcome, reviewOutcome } from "./handoff.js";
import { review } from "./runner.js";
import { chooseModel, setup } from "./setup.js";
import { assertCurrent, capture } from "./snapshot.js";
import { storageRoot } from "./storage.js";
import type { Report } from "./types.js";
import { createWorkUI, directWork, type WorkPhase } from "./work-ui.js";

interface Outcome {
	text: string;
	report?: Report;
	path?: string;
	handoff?: boolean;
}
export default function prReview(pi: ExtensionAPI): void {
	let active: { controller: AbortController; action: string; cancel(): void } | undefined;
	let generation = 0;
	const cancel = () => {
		generation++;
		active?.cancel();
		active = undefined;
	};
	pi.on("session_shutdown", cancel);
	pi.on("session_tree", cancel);

	async function perform(
		action: "review" | "setup" | "model",
		args: string,
		ctx: ExtensionContext,
		signal: AbortSignal,
		progress: (message: string) => void,
		work: WorkPhase,
	): Promise<Outcome> {
		if (ctx.mode !== "tui" || !ctx.hasUI)
			throw new Error("PR review requires interactive Pi TUI; approvals cannot be bypassed.");
		if (!ctx.isProjectTrusted())
			throw new Error("Trust this project in Pi before setting up or running PR review.");
		// Reject malformed scopes before opening a spinner or touching Git/config.
		const scope = action === "review" ? parseScope(args) : undefined;
		const { repo, root } = await work("Checking repository", async () => {
			const repo = await resolveRepo(ctx.cwd, signal);
			return { repo, root: await storageRoot(getAgentDir(), repo) };
		});
		if (action === "model") {
			const model = await chooseModel(ctx, root, signal, work);
			return { text: `Independent review model: ${model.provider}/${model.model} (${model.thinking})` };
		}
		if (action === "setup") return { text: await setup(ctx, repo, root, signal, progress, work) };
		const { loaded, config, plannotatorDir, prompts } = await work(
			"Checking saved review context",
			async () => {
				const loaded = await loadProfile(root, repo.id);
				if (!loaded)
					throw new Error(
						"No approved repository review context. Run /pr setup and complete the profile approval; selecting a model alone does not finish setup.",
					);
				const config = await loadConfig(root);
				if (!config) throw new Error("Select an independent model with /pr model or /pr setup first.");
				const model = ctx.modelRegistry.find(config.provider, config.model);
				if (!model || !ctx.modelRegistry.hasConfiguredAuth(model))
					throw new Error("Configured review model unavailable; use /pr model.");
				return {
					loaded,
					config,
					plannotatorDir: await installedPlannotator(pi),
					prompts: await loadPrompts(),
				};
			},
		);
		const snapshot = await work("Capturing changes", () =>
			capture(repo, scope!, config, loaded.profile.draft.exclusions, signal),
		);
		const report = await review({
			ctx,
			config,
			profile: loaded.profile,
			snapshot,
			prompts,
			scope: scope!,
			signal,
			progress,
			work,
		});
		await saveReport(root, report, config.historyLimit);
		const path = join(root, "repos", repo.id, "reports", `${report.id}.json`);
		if (
			report.status !== "cancelled" &&
			report.status !== "no-changes" &&
			snapshot.changes.length &&
			!signal.aborted
		) {
			try {
				report.browser = await work("Waiting for Plannotator feedback", () =>
					present({
						root,
						piPackageDir: getPackageDir(),
						plannotatorDir,
						report,
						snapshot,
						signal,
						progress,
					}),
				);
				if (report.browser.requestedIds.length) {
					try {
						await work("Checking source before fix handoff", () => assertCurrent(snapshot, config, signal));
					} catch {
						report.browser.requestedIds = [];
						report.issues.push("Source changed since review; requested fixes were withheld. Rerun /pr.");
						report.status = "incomplete";
					}
				}
			} catch (error) {
				report.status = signal.aborted ? "cancelled" : "incomplete";
				report.issues.push(
					error instanceof Error ? error.message : "Browser review failed; no fixes authorized",
				);
			}
			await saveReport(root, report, config.historyLimit);
		}
		signal.throwIfAborted();
		return { ...reviewOutcome(report, path, prompts.text["fix-handoff"]), report, path };
	}
	async function operation(
		action: "review" | "setup" | "model",
		args: string,
		ctx: ExtensionContext,
		outer: AbortSignal | undefined,
		progress: (message: string) => void,
		work: WorkPhase = directWork,
		cancelUI?: () => void,
	): Promise<Outcome> {
		if (active)
			throw new Error(
				`A PR ${active.action} operation is already active in this session; cancel it before starting another.`,
			);
		const current = {
			controller: new AbortController(),
			action,
			cancel() {
				this.controller.abort();
				cancelUI?.();
			},
		};
		active = current;
		const abort = () => current.controller.abort();
		outer?.addEventListener("abort", abort, { once: true });
		if (outer?.aborted) abort();
		try {
			const outcome = await perform(
				action,
				args,
				ctx,
				current.controller.signal,
				(message) => {
					if (active === current && !current.controller.signal.aborted) progress(message);
				},
				work,
			);
			if (active !== current || current.controller.signal.aborted) throw new Error("PR operation cancelled");
			return outcome;
		} finally {
			outer?.removeEventListener("abort", abort);
			if (active === current) active = undefined;
		}
	}
	pi.registerCommand("pr", {
		description:
			"Review changes in Plannotator; /pr setup creates or regenerates context, /pr model chooses the independent model",
		getArgumentCompletions: (prefix) =>
			["setup", "model", "--commits", "--base", "--committed-only"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI || !ctx.isIdle()) {
				if (ctx.hasUI) ctx.ui.notify("Run /pr in an idle interactive TUI session.", "warning");
				return;
			}
			const action = args.trim() === "setup" ? "setup" : args.trim() === "model" ? "model" : "review";
			const controller = new AbortController();
			const owner = generation;
			const ui = createWorkUI(ctx, controller.signal, () => controller.abort());
			try {
				const result = await operation(action, args, ctx, controller.signal, ui.update, ui.run, () =>
					controller.abort(),
				);
				if (owner !== generation) return;
				pi.sendMessage(
					{
						customType: "pr-review",
						content: displayOutcome(result),
						display: true,
						details: { reportId: result.report?.id, path: result.path },
					},
					{ triggerTurn: result.handoff ?? false },
				);
			} catch (error) {
				if (owner !== generation) return;
				const message = controller.signal.aborted
					? `PR ${action} cancelled.`
					: `PR ${action} stopped: ${error instanceof Error ? error.message : String(error)}`;
				// Keep errors in the transcript, not only a footer/status that a custom layout may hide.
				pi.sendMessage({ customType: "pr-review", content: message, display: true }, { triggerTurn: false });
			} finally {
				if (owner === generation) ctx.ui.setStatus("pr-review", undefined);
			}
		},
	});
	pi.registerTool({
		name: "pr_review",
		label: "PR review",
		description:
			"Run the code-owned repository review pipeline and open verified findings in Plannotator. Requires explicit /pr setup and interactive approvals. Browser feedback can authorize the parent agent to fix selected verified findings; this tool never edits project files.",
		promptSnippet: "Run repository-aware, independently verified code review",
		promptGuidelines: [
			"Use pr_review for repository-aware review requests. If setup is missing or stale, ask the user to run /pr setup; do not silently substitute an old Claude Task-based skill.",
		],
		parameters: Type.Object(
			{
				commits: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
				base: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
				committedOnly: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
		async execute(_id, args, signal, onUpdate, ctx) {
			if (args.commits !== undefined && args.base !== undefined)
				throw new Error("Choose commits or base, not both");
			const scopeArgs = `${args.commits !== undefined ? `--commits ${args.commits}` : args.base !== undefined ? `--base ${args.base}` : ""}${args.committedOnly ? " --committed-only" : ""}`;
			const result = await operation("review", scopeArgs, ctx, signal, (message) =>
				onUpdate?.({ content: [{ type: "text", text: message }], details: {} }),
			);
			const usage = result.report?.usage;
			return {
				content: [
					{
						type: "text",
						text: displayOutcome(result),
					},
				],
				details: { reportId: result.report?.id, status: result.report?.status, path: result.path },
				...(usage
					? {
							usage: {
								input: usage.input,
								output: usage.output,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: usage.input + usage.output,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
							},
						}
					: {}),
			};
		},
	});
}
