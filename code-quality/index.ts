import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { QualityController, type RuntimePorts } from "./controller.js";
import { qualityUI, feedbackRenderer, checkingRenderer } from "./ui.js";
import { createQualityActivityPublisher, type QualityActivityPublisher } from "./activity.js";
import { QUALITY_CHECK_ENTRY } from "./feedback.js";
import { LspManager } from "./lsp-manager.js";
import { handleLspCommand } from "./lsp-commands.js";
import { canonicalPath, readSnapshot } from "./capture.js";
import { resolve } from "node:path";
import { diagnosticLabel } from "./lsp-diagnostics.js";

export function registerQualityGate(pi: ExtensionAPI, ports: RuntimePorts, agentDir = getAgentDir()): void {
	const runtime = new QualityController(pi, agentDir, { ...ports });
	let activity: QualityActivityPublisher | undefined;
	let lsp: LspManager | undefined;
	let lspStartup: Promise<void> = Promise.resolve();
	let context: Parameters<QualityController["start"]>[0] | undefined;
	let sessionAbort = new AbortController();
	let lspSetupError: string | undefined;
	pi.registerMessageRenderer("code-quality:feedback", feedbackRenderer);
	pi.registerEntryRenderer(QUALITY_CHECK_ENTRY, checkingRenderer);
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		sessionAbort = new AbortController();
		lspSetupError = undefined;
		activity?.dispose();
		activity = ctx.mode === "tui" ? createQualityActivityPublisher(pi.events) : undefined;
		runtime.ports.activity = activity;
		runtime.start(ctx);
		if (ctx.mode === "tui") {
			lsp = new LspManager(agentDir, () => {
				activity?.updateLsp(lsp?.header ?? []);
				if (context) context.ui.setStatus("quality-lsp", lsp?.statusText());
			});
			const checkFilesAfterStartup: LspManager["check"] = async (files, signal) => {
				const manager = lsp!;
				await lspStartup;
				signal.throwIfAborted();
				return manager.check(files, signal);
			};
			runtime.ports.lsp = {
				check: checkFilesAfterStartup,
				restart: (id, signal) => lsp!.restart(id, signal),
				get revision() {
					return lsp?.revision ?? 0;
				},
				get configRevision() {
					return lsp?.configRevision ?? "unconfigured";
				},
			};
			lspStartup = runtime.active ? lsp.start(ctx.cwd, ctx.isProjectTrusted()) : Promise.resolve();
			lspStartup.catch((error) => {
				lspSetupError = String(error);
				ctx.ui.notify(`LSP setup unavailable: ${lspSetupError}`, "warning");
			});
		}
	});
	pi.on("session_tree", (_event, ctx) => {
		sessionAbort.abort();
		sessionAbort = new AbortController();
		runtime.start(ctx);
		activity?.updateLsp(lsp?.header ?? []);
	});
	pi.on("session_shutdown", async () => {
		sessionAbort.abort();
		context = undefined;
		runtime.dispose();
		await lspStartup.catch(() => {});
		await lsp?.stop();
		lsp = undefined;
		runtime.ports.lsp = undefined;
		activity?.dispose();
		activity = undefined;
		runtime.ports.activity = undefined;
	});
	pi.on("before_agent_start", (event, ctx) => {
		event.systemPromptOptions.sections.code_quality =
			runtime.policy +
			(ctx.mode === "tui" && runtime.active
				? `\n${runtime.summary()}`
				: "\nQuality gate is inactive; policy is guidance only in this mode.");
	});
	pi.on("tool_call", (event, ctx) => runtime.beforeTool(event.toolName, event.input, ctx, event.toolCallId));
	pi.on("tool_result", async (event, ctx) => {
		if (
			ctx.mode !== "tui" ||
			event.isError ||
			!runtime.active ||
			!lsp ||
			!["edit", "write"].includes(event.toolName)
		)
			return;
		if (typeof event.input.path !== "string") return;
		const owner = sessionAbort;
		await lspStartup.catch(() => {});
		if (owner.signal.aborted || !lsp) return;
		if (lspSetupError) {
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text: `LSP unavailable: ${lspSetupError}. Configure with /quality lsp setup.`,
					},
				],
				details: event.details,
				usage: event.usage,
				isError: event.isError,
			};
		}
		const path = canonicalPath(resolve(ctx.cwd, event.input.path));
		const snapshot = runtime.state?.files.find((file) => file.path === path);
		if (!snapshot) return;
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, owner.signal]) : owner.signal;
		let after: string | null;
		try {
			after = readSnapshot(path, runtime.config, ctx.cwd, runtime.state?.authorized.includes(path));
		} catch {
			return;
		}
		const checked = await lsp
			.check([{ path, after }], signal)
			.catch((error) => ({ kind: "unavailable" as const, reason: String(error) }));
		if (owner.signal.aborted || !checked) return;
		let text: string;
		if (checked.kind === "checked") {
			text = checked.findings.length
				? `LSP diagnostics (file was written):\n${checked.findings.map(diagnosticLabel).join("\n")}`
				: "LSP: no diagnostics for this file snapshot; quality batch review is still pending.";
		} else {
			text = `LSP ${checked.kind}: ${checked.reason}. The file mutation succeeded; quality review remains pending.`;
		}
		const previewLimit = 12000;
		if (text.length > previewLimit)
			text = `${text.slice(0, previewLimit)}\nLSP preview truncated; the batch boundary will collect the complete findings before deciding.`;
		return {
			content: [...event.content, { type: "text" as const, text }],
			details: event.details,
			usage: event.usage,
			isError: event.isError,
		};
	});
	pi.on("tool_execution_end", (event) => runtime.finishTool(event.toolCallId, event.isError));
	pi.on("turn_end", (event, ctx) => runtime.boundary(ctx, event.outcome));
	pi.on("agent_before_settle", (event, ctx) => runtime.boundary(ctx, event.outcome, true));
	pi.registerTool({
		name: "quality_response",
		label: "Quality response",
		description:
			"Send a bounded disagreement to the quality reviewer for reconsideration, or request user-approved helper/test paths. Corrections and disagreements share five review rounds before automatic operator arbitration. Cannot approve, disable, or waive a review.",
		executionMode: "sequential",
		parameters: Type.Object({
			action: Type.String({ enum: ["disagree", "request_scope"] }),
			caseId: Type.String(),
			revision: Type.String(),
			rationale: Type.String({ minLength: 1, maxLength: 2000 }),
			paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 12 })),
		}),
		async execute(_id, input, _signal, _update, ctx) {
			const text = await runtime.respond(input as Parameters<typeof runtime.respond>[0], ctx);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
	pi.registerCommand("quality", {
		description: "Quality gate status, on/off, retry, or resolve",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "lsp" || action.startsWith("lsp ")) {
				if (!lsp) {
					ctx.ui.notify("LSP quality requires TUI mode", "warning");
					return;
				}
				if (action !== "lsp" && action !== "lsp status") await ctx.waitForIdle();
				const statusOnly = action === "lsp" || action === "lsp status";
				const finishAttention = statusOnly ? undefined : activity?.requestDecision("lsp_setup");
				try {
					await handleLspCommand(
						action.slice(3).trim(),
						ctx,
						agentDir,
						{
							status: () => lsp!.statusText(),
							validate: (route, project, signal) => lsp!.validate(route, project, signal),
							progress: (text) => ctx.ui.setStatus("quality-lsp-setup", text.slice(-200)),
							restart: (id, signal) => lsp!.restart(id, signal),
							reload: async () => {
								await lsp!.stop();
								lspStartup = lsp!.start(ctx.cwd, ctx.isProjectTrusted());
								await lspStartup;
								lspSetupError = undefined;
							},
							hasPendingCase: () => runtime.pending,
							waivePendingLsp: () => runtime.waiveLsp(),
						},
						sessionAbort.signal,
					);
				} finally {
					finishAttention?.();
					ctx.ui.setStatus("quality-lsp-setup", undefined);
				}
				return;
			}
			if (action && action !== "status") await ctx.waitForIdle();
			await runtime.command(action, ctx);
			if (action === "off" && !runtime.active) await lsp?.stop();
			if (action === "on" && runtime.active) {
				await lsp?.stop();
				lspStartup = lsp?.start(ctx.cwd, ctx.isProjectTrusted()) ?? Promise.resolve();
				await lspStartup;
				lspSetupError = undefined;
			}
		},
	});
	pi.registerCommand("quality-model", {
		description: "Select and persist the isolated quality reviewer model",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Quality gate inactive outside TUI", "info");
				return;
			}
			await ctx.waitForIdle();
			if (await runtime.selectModel(ctx, args.trim()))
				ctx.ui.notify("Quality reviewer saved; /quality retry resumes a pending case", "info");
		},
	});
}
export default function codeQuality(pi: ExtensionAPI): void {
	registerQualityGate(pi, { ui: qualityUI });
}
