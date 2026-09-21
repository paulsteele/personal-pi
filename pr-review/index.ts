import { join } from "node:path";
import { toProviderUsage } from "./usage.js";
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
import { redact, saveReport } from "./report.js";
import { displayOutcome, reviewOutcome } from "./handoff.js";
import { review } from "./runner.js";
import { approveSetup, chooseModel, setup } from "./setup.js";
import { assertCurrent, capture, type Snapshot } from "./snapshot.js";
import { TaskStore, RecoveryGate } from "./tasks.js";
import { createReviewDashboard, trackPermissionPrompts, type ReviewDashboard } from "./dashboard.js";
import { createRunJournal } from "./journal.js";
import { storageRoot } from "./storage.js";
import type { Report, Repo } from "./types.js";
import { openReviewPermissions, isPermissionBlocked, type ReviewPermissions } from "./permissions.js";
import { createWorkUI, directWork, type WorkPhase, type WorkUI } from "./work-ui.js";

interface Outcome {
	text: string;
	report?: Report;
	path?: string;
	handoff?: boolean;
	validate?: () => Promise<{ text: string; handoff: boolean } | void>;
}
interface ActiveOperation {
	controller: AbortController;
	action: string;
	cancel(): void;
	tasks?: TaskStore;
	recovery?: RecoveryGate;
	dashboard?: ReviewDashboard;
	permissions?: ReviewPermissions;
	phaseUI?: WorkUI;
}
export default function prReview(pi: ExtensionAPI): void {
	let active: ActiveOperation | undefined;
	let lastTasks: TaskStore | undefined;
	let lastDashboard: ReviewDashboard | undefined;
	let permissionPrompts: ReturnType<typeof trackPermissionPrompts> | undefined;
	const observePermissionPrompts = () => {
		permissionPrompts ??= trackPermissionPrompts(pi.events, (showing) => {
			// Main-agent prompts matter too: a background PR must not obscure them.
			active?.dashboard?.setPermissionPromptActive(showing);
			active?.phaseUI?.setPermissionPromptActive(showing);
			lastDashboard?.setPermissionPromptActive(showing);
		});
	};
	let generation = 0;
	const cancel = () => {
		generation++;
		active?.cancel();
		active?.dashboard?.dispose();
		lastDashboard?.dispose();
		lastDashboard = undefined;
		lastTasks = undefined;
		active = undefined;
	};
	pi.on("session_start", observePermissionPrompts);
	pi.on("session_shutdown", () => {
		cancel();
		permissionPrompts?.dispose();
		permissionPrompts = undefined;
	});
	pi.on("session_tree", cancel);

	async function perform(
		action: "review" | "setup" | "model",
		args: string,
		ctx: ExtensionContext,
		signal: AbortSignal,
		progress: (message: string, taskActivity?: boolean) => void,
		work: WorkPhase,
		getPermissions: (repo: Repo, scope: string) => ReviewPermissions,
		tasks?: TaskStore,
		recovery?: RecoveryGate,
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
		if (action === "setup") {
			const mode = args.trim().slice("setup".length).trim();
			if (mode === "approve")
				return {
					text: await work("Activating approved profile draft", () => approveSetup(repo, root, signal)),
				};
			if (mode && mode !== "edit" && mode !== "regenerate")
				throw new Error("Use /pr setup, /pr setup edit, /pr setup approve, or /pr setup regenerate.");
			return {
				text: await setup(
					ctx,
					repo,
					root,
					signal,
					progress,
					work,
					mode === "edit" ? "edit" : mode === "regenerate" ? "regenerate" : "normal",
					() => getPermissions(repo, "Discover repository context for PR setup"),
				),
			};
		}
		const { loaded, config, plannotatorDir, prompts } = await work(
			"Checking saved review context",
			async () => {
				const loaded = await loadProfile(root, repo.id);
				if (!loaded)
					throw new Error(
						"No approved repository review context. Run /pr setup, inspect the saved draft in your editor, then run /pr setup approve; selecting a model alone does not finish setup.",
					);
				const config = await loadConfig(root, (message) => ctx.ui.notify(message, "info"));
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
		const permissions = getPermissions(repo, JSON.stringify(scope));
		const captureAccess = permissions.host("Capture source for PR review", "capture");
		const outputAccess = permissions.host("Authorize PR output", "output");
		const authorizeOutput = async () => {
			for (;;) {
				try {
					const revision = await outputAccess.authorizeSources(
						permissions.dependencies,
						"Publish captured/derived source in the PR report and local viewer",
						signal,
					);
					if (tasks?.records.has("output"))
						tasks.update("output", { state: "completed", endedAt: Date.now() }, "Output authorized");
					if (revision !== outputAccess.revision()) continue;
					return revision;
				} catch (error) {
					signal.throwIfAborted();
					if (!isPermissionBlocked(error) || !recovery) throw error;
					if (tasks && !tasks.records.has("output"))
						tasks.add({
							id: "output",
							stage: "permission",
							name: "Authorize output",
							files: [],
							reason: "Live permission check before disclosure",
						});
					await recovery.block("output", error.message);
				}
			}
		};
		const persistReport = async (report: Report) => {
			for (;;) {
				const revision = await authorizeOutput();
				if (revision !== outputAccess.revision()) continue;
				await saveReport(root, report, config.historyLimit);
				return;
			}
		};
		const journal = tasks
			? await createRunJournal(root, repo.id, tasks, () =>
					ctx.ui.notify("PR progress journal unavailable; review continues with live status.", "warning"),
				).catch(() => undefined)
			: undefined;
		if (tasks && journal) tasks.journalPath = journal.path;
		try {
			let snapshot: Snapshot | undefined;
			tasks?.add({
				id: "capture",
				stage: "capture",
				name: "Capture source",
				files: [],
				reason: "Immutable in-scope snapshot; no size exclusions",
			});
			await work("Capturing changes", async () => {
				for (;;) {
					signal.throwIfAborted();
					tasks?.update("capture", { state: "running", startedAt: Date.now() });
					try {
						snapshot = await capture(
							repo,
							scope!,
							config,
							captureAccess,
							loaded.profile.draft.exclusions,
							signal,
						);
						const blocked = snapshot.omitted.filter((item) => !item.reason.startsWith("excluded:"));
						if (blocked.length) {
							tasks?.update("capture", { files: blocked.map((item) => item.file) });
							throw new Error(blocked.map((item) => `${item.file}: ${item.reason}`).join("; "));
						}
						tasks?.update(
							"capture",
							{ state: "completed", endedAt: Date.now(), files: snapshot.changes.map((item) => item.file) },
							"Snapshot ready",
						);
						return;
					} catch (error) {
						await snapshot?.dispose?.();
						snapshot = undefined;
						signal.throwIfAborted();
						if (!recovery) throw error;
						await recovery.block("capture", error instanceof Error ? error.message : "Source capture failed");
					}
				}
			});
			const captured = snapshot!;
			try {
				const report = await review({
					ctx,
					config,
					permissions,
					profile: loaded.profile,
					snapshot: captured,
					prompts,
					scope: scope!,
					signal,
					progress: (message) => progress(message, true),
					work,
					...(tasks ? { tasks } : {}),
					...(recovery ? { recovery } : {}),
				});
				if (tasks && !tasks.records.has("output"))
					tasks.add({
						id: "output",
						stage: "permission",
						name: "Authorize output",
						files: [],
						reason: "Live permission check before disclosure",
					});
				await work("Authorizing and saving review report", () => persistReport(report));
				const path = join(root, "repos", repo.id, "reports", `${report.id}.json`);
				if (
					report.status !== "cancelled" &&
					report.status !== "no-changes" &&
					!report.issues.some((issue) => issue.startsWith("Permission blocked:")) &&
					captured.changes.length &&
					!signal.aborted &&
					report.tasks?.some((task) => task.stage === "review") &&
					report.tasks.every((task) => task.state === "completed" || task.state === "skipped")
				) {
					try {
						report.browser = await work("Waiting for Plannotator feedback", () =>
							present({
								root,
								piPackageDir: getPackageDir(),
								plannotatorDir,
								report,
								authorize: authorizeOutput,
								permissionRevision: () => outputAccess.revision(),
								snapshot: captured,
								signal,
								progress: (message) => {
									if (signal.aborted || active?.controller.signal !== signal) return;
									progress(message);
									try {
										ctx.ui.notify(redact(message), "info");
									} catch {
										/* Progress presentation is non-authoritative. */
									}
								},
							}),
						);
						if (report.browser.requestedIds.length) {
							try {
								await work("Checking source before fix handoff", () =>
									assertCurrent(captured, config, signal),
								);
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
					await work("Authorizing and saving browser feedback", () => persistReport(report));
				}
				signal.throwIfAborted();
				tasks?.setPhase(`Review ${report.status}`);
				return {
					...reviewOutcome(report, path, prompts.text["fix-handoff"]),
					report,
					path,
					...(report.browser?.requestedIds.length
						? {
								validate: async () => {
									try {
										await assertCurrent(captured, config, signal);
									} catch (error) {
										signal.throwIfAborted();
										if (isPermissionBlocked(error)) throw error;
										report.browser!.requestedIds = [];
										report.status = "incomplete";
										const issue = `Final source validation failed; requested fixes were withheld. ${error instanceof Error ? error.message : "Rerun /pr."}`;
										if (!report.issues.includes(issue)) report.issues.push(issue);
										await persistReport(report);
										return reviewOutcome(report, path, prompts.text["fix-handoff"]);
									}
								},
							}
						: {}),
				};
			} finally {
				await captured.dispose?.();
			}
		} finally {
			if (signal.aborted) {
				tasks?.cancel();
				tasks?.setPhase("Review cancelled");
			}
			await journal?.close();
		}
	}
	async function operation(
		action: "review" | "setup" | "model",
		args: string,
		ctx: ExtensionContext,
		outer: AbortSignal | undefined,
		progress: (message: string, isCurrent: () => boolean) => void,
		work: WorkPhase = directWork,
		cancelUI?: () => void,
		parentToolCallId?: string,
		phaseUI?: WorkUI,
	): Promise<Outcome> {
		if (active)
			throw new Error(
				`A PR ${active.action} operation is already active in this session; cancel it before starting another.`,
			);
		observePermissionPrompts();
		lastDashboard?.dispose();
		lastDashboard = undefined;
		const current: ActiveOperation = {
			controller: new AbortController(),
			action,
			...(phaseUI ? { phaseUI } : {}),
			cancel() {
				this.controller.abort();
				this.permissions?.close();
				cancelUI?.();
			},
		};
		active = current;
		phaseUI?.setPermissionPromptActive(permissionPrompts?.active ?? false);
		if (action === "review" && ctx.mode === "tui") {
			current.tasks = new TaskStore();
			current.recovery = new RecoveryGate(current.tasks, current.controller.signal);
			current.dashboard = createReviewDashboard(ctx, current.tasks, {
				cancel: () => current.cancel(),
				recovery: current.recovery,
			});
			current.dashboard.setPermissionPromptActive(permissionPrompts?.active ?? false);
		}
		const abort = () => current.cancel();
		outer?.addEventListener("abort", abort, { once: true });
		if (outer?.aborted) abort();
		let finished = false;
		try {
			const outcome = await perform(
				action,
				args,
				ctx,
				current.controller.signal,
				(message, taskActivity) => {
					if (active === current && !current.controller.signal.aborted) {
						// Workers already publish task-local events; only phase-level progress belongs here.
						if (!taskActivity) {
							try {
								current.dashboard?.update(message);
							} catch {
								/* Keep the original sink usable. */
							}
						}
						try {
							progress(message, () => active === current && !current.controller.signal.aborted);
						} catch {
							/* A progress renderer must not stop review work. */
						}
					}
				},
				current.dashboard?.work ?? work,
				(repo, scope) =>
					(current.permissions ??= openReviewPermissions(
						pi,
						ctx,
						repo,
						scope,
						current.controller.signal,
						parentToolCallId ? { parentToolCallId } : { command: `/pr${args ? ` ${args}` : ""}` },
						(event) => current.tasks?.permission(event),
					)),
				current.tasks,
				current.recovery,
			);
			if (active !== current || current.controller.signal.aborted) throw new Error("PR operation cancelled");
			if (current.permissions) {
				const permissionOwner = current.permissions;
				const access = permissionOwner.host("Return PR output to the parent");
				await (current.dashboard?.work ?? work)("Authorizing parent handoff", async () => {
					for (;;) {
						try {
							const revision = await access.authorizeSources(
								permissionOwner.dependencies,
								"Return the authorized review result to the parent",
								current.controller.signal,
							);
							const corrected = await outcome.validate?.();
							if (corrected) Object.assign(outcome, corrected);
							if (revision !== access.revision()) continue;
							break;
						} catch (error) {
							current.controller.signal.throwIfAborted();
							if (!isPermissionBlocked(error) || !current.recovery) throw error;
							if (!current.tasks?.records.has("output"))
								current.tasks?.add({
									id: "output",
									stage: "permission",
									name: "Authorize output",
									files: [],
									reason: "Live permission check before parent handoff",
								});
							await current.recovery.block("output", error.message);
						}
					}
				});
				if (current.tasks?.records.has("output"))
					current.tasks.update("output", { state: "completed", endedAt: Date.now() }, "Output authorized");
			}
			if (outcome.path) {
				try {
					// Optional permission-system integration: only this saved report, only
					// this session, before either command or tool publishes its handoff.
					pi.events.emit("permissions:allow_session_files", {
						version: 1,
						sessionId: ctx.sessionManager.getSessionId(),
						paths: [outcome.path],
					});
				} catch {
					/* Permission integration must not discard a completed review. */
				}
			}
			current.tasks?.setPhase(`Review ${outcome.report?.status ?? "finished"}`);
			finished = true;
			return outcome;
		} finally {
			outer?.removeEventListener("abort", abort);
			current.permissions?.close();
			current.phaseUI?.dispose();
			current.dashboard?.dispose();
			if (current.controller.signal.aborted) {
				current.tasks?.cancel();
				current.tasks?.setPhase("Review cancelled");
			} else if (!finished) current.tasks?.setPhase("Review stopped");
			if (active === current) {
				lastTasks = current.tasks ?? lastTasks;
				active = undefined;
			}
		}
	}
	pi.registerCommand("pr", {
		description:
			"Review changes; /pr setup creates an editable profile draft, /pr setup approve activates it, /pr model chooses the review model",
		getArgumentCompletions: (prefix) =>
			[
				"setup",
				"setup edit",
				"setup approve",
				"setup regenerate",
				"model",
				"status",
				"retry",
				"cancel",
				"--commits",
				"--base",
				"--committed-only",
			]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (ctx.mode === "tui" && ctx.hasUI && ["status", "retry", "cancel"].includes(args.trim())) {
				if (args.trim() === "cancel") {
					if (active) active.cancel();
					else ctx.ui.notify("No PR operation is running.", "info");
				} else if (args.trim() === "retry") {
					if (active?.recovery?.blockers.size) active.recovery.retry();
					else ctx.ui.notify("No blocked PR work to retry.", "info");
				} else if (active?.dashboard) active.dashboard.show();
				else if (lastTasks) {
					lastDashboard?.dispose();
					lastDashboard = createReviewDashboard(ctx, lastTasks, {
						readonly: true,
						cancel: () => lastDashboard?.dispose(),
					});
					lastDashboard.setPermissionPromptActive(permissionPrompts?.active ?? false);
					lastDashboard.show();
				} else ctx.ui.notify("No review task history in this session.", "info");
				return;
			}
			if (ctx.mode !== "tui" || !ctx.hasUI || !ctx.isIdle()) {
				if (ctx.hasUI) ctx.ui.notify("Run /pr in an idle interactive TUI session.", "warning");
				return;
			}
			if (active) {
				ctx.ui.notify(
					`A PR ${active.action} operation is already active. Use /pr status, /pr retry, or /pr cancel.`,
					"warning",
				);
				return;
			}
			const action =
				args.trim() === "setup" || args.trim().startsWith("setup ")
					? "setup"
					: args.trim() === "model"
						? "model"
						: "review";
			const controller = new AbortController();
			const owner = generation;
			const ui =
				action === "review" ? undefined : createWorkUI(ctx, controller.signal, () => controller.abort());
			const executeCommand = async () => {
				try {
					const result = await operation(
						action,
						args,
						ctx,
						controller.signal,
						ui?.update ?? (() => {}),
						ui?.run ?? directWork,
						() => controller.abort(),
						undefined,
						ui,
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
					pi.sendMessage(
						{ customType: "pr-review", content: message, display: true },
						{ triggerTurn: false },
					);
				} finally {
					if (action !== "review" && owner === generation && !active)
						ctx.ui.setStatus("pr-review", undefined);
				}
			};
			if (action === "review") {
				// Pi's idle input loop awaits command handlers. Keep the owned operation alive,
				// but release that loop so status/retry/cancel work before browser feedback.
				void executeCommand().catch(() => {
					if (owner === generation) {
						try {
							ctx.ui.notify("PR review stopped; unable to publish its outcome.", "error");
						} catch {
							/* Retired UI. */
						}
					}
				});
			} else await executeCommand();
		},
	});
	pi.registerTool({
		name: "pr_review",
		label: "PR review",
		description:
			"Run the code-owned repository review pipeline and open verified findings in Plannotator. Requires explicit /pr setup and interactive approvals. Browser feedback can authorize the parent agent to fix selected verified findings; this tool never edits project files.",
		promptSnippet: "Run repository-aware, independently verified code review",
		promptGuidelines: [
			"Use pr_review for repository-aware review requests. An approved profile remains usable after repository changes. If setup is missing, ask the user to run /pr setup and approve the saved draft with /pr setup approve; do not silently substitute an old Claude Task-based skill.",
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
			let updateTimer: ReturnType<typeof setTimeout> | undefined,
				latest = "";
			let result: Outcome;
			let canDeliver = () => false;
			try {
				result = await operation(
					"review",
					scopeArgs,
					ctx,
					signal,
					(message, isCurrent) => {
						canDeliver = isCurrent;
						latest = message;
						if (!updateTimer)
							updateTimer = setTimeout(() => {
								updateTimer = undefined;
								if (signal?.aborted || !canDeliver()) return;
								try {
									onUpdate?.({ content: [{ type: "text", text: latest }], details: {} });
								} catch {
									/* Retired tool renderer. */
								}
							}, 100);
					},
					directWork,
					() => {
						canDeliver = () => false;
						clearTimeout(updateTimer);
						updateTimer = undefined;
					},
					_id,
				);
			} finally {
				clearTimeout(updateTimer);
			}
			const usage = result.report ? toProviderUsage(result.report.usage) : undefined;
			return {
				content: [
					{
						type: "text",
						text: displayOutcome(result),
					},
				],
				details: { reportId: result.report?.id, status: result.report?.status, path: result.path },
				...(usage ? { usage } : {}),
			};
		},
	});
}
