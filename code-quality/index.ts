import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { QualityController, type RuntimePorts } from "./controller.js";
import { qualityUI, feedbackRenderer, createCheckingRenderer } from "./ui.js";
import { createQualityActivityPublisher, type QualityActivityPublisher } from "./activity.js";
import { QUALITY_CHECK_ENTRY } from "./feedback.js";
import { SandboxLspManager } from "./lsp-sandbox-manager.js";
import type { LspManager } from "./lsp-manager.js";
import { handleLspCommand } from "./lsp-commands.js";
import { setupSandboxLsp } from "./lsp-sandbox-setup.js";
import { validateAndActivateLspDraft, type LspSetupPorts } from "./lsp-setup.js";
import { qualitySandbox, readGuestSnapshot } from "./sandbox.js";
import { diagnosticLabel } from "./lsp-diagnostics.js";
import { registerSettingsSection, settingsFlowContext } from "@paulsteele/pi-shared-ui";
import {
	resolveLspProject,
	loadLspProfile,
	loadLspDraft,
	parseLspProfile,
	publishLspDraft,
} from "./lsp-profile.js";
import { loadConfig, qualityConfigRevision } from "./config.js";
import { SandboxDryManager } from "./dry-sandbox-manager.js";
import { createDryGate } from "./dry-check.js";
import { handleDryCommand, type DryCommandPorts } from "./dry-commands.js";
import { loadDryProfile, parseDryProfile, resolveDryProject, saveDryProfile } from "./dry-profile.js";

export function registerQualityGate(pi: ExtensionAPI, ports: RuntimePorts, agentDir = getAgentDir()): void {
	const runtime = new QualityController(pi, agentDir, { ...ports });
	let activity: QualityActivityPublisher | undefined;
	let lsp: SandboxLspManager | LspManager | undefined;
	let lspStartup: Promise<void> = Promise.resolve();
	let context: Parameters<QualityController["start"]>[0] | undefined;
	let sessionAbort = new AbortController();
	let lspSetupError: string | undefined;
	let dry: SandboxDryManager | undefined;
	let dryStartup: Promise<void> = Promise.resolve();
	let dryRestartPending = false;
	const restartDry = async (ctx: ExtensionContext): Promise<void> => {
		if (!dry) {
			return;
		}
		dryRestartPending = true;
		dryStartup = dry.start(ctx.cwd, ctx.isProjectTrusted(), { ...runtime.config, enabled: runtime.active });
		try {
			await dryStartup;
		} finally {
			dryRestartPending = false;
		}
	};
	const dryCommandPorts = (): DryCommandPorts => {
		if (!dry) {
			throw new Error("DRY requires an interactive quality session");
		}
		return {
			manager: dry,
			async setEnabled(enabled, ctx, signal) {
				if (!enabled && runtime.pending && !runtime.state?.dryWaived) {
					const approved = await ctx.ui.confirm(
						"Disable pending DRY?",
						"This explicitly waives only DRY for the current case.",
					);
					if (!approved) {
						return;
					}
					runtime.waiveDry();
				}
				await runtime.applySettings(ctx, { ...runtime.config, dryEnabled: enabled }, signal);
				await restartDry(ctx);
			},
		};
	};
	const qualityPlugin = {
		id: "quality",
		title: "Code Quality",
		description: "Reviewer, diagnostics, and language servers",
	};
	registerSettingsSection(pi, {
		plugin: qualityPlugin,
		id: "quality",
		title: "Review Settings",
		description: "Reviewer, diagnostic gate, and review limits",
		effect: "Quality settings applied. Pending reviews retain their approval/waiver requirements.",
		fields: [
			{ path: "enabled", label: "Enabled", kind: "boolean" },
			{ path: "modelSelection", label: "Reviewer model", kind: "model" },
			{ path: "timeoutMs", label: "Reviewer timeout (ms)", kind: "number" },
			{ path: "maxFileBytes", label: "Maximum file bytes", kind: "number" },
			{ path: "maxBatchBytes", label: "Maximum batch bytes", kind: "number" },
			{ path: "maxInputChars", label: "Maximum input characters", kind: "number" },
			{ path: "maxOutputTokens", label: "Maximum output tokens", kind: "number" },
		],
		async load(ctx) {
			const settingsFormConfigRevision = qualityConfigRevision(agentDir);
			const loaded = loadConfig(agentDir);
			if (loaded.error) {
				throw new Error(loaded.error);
			}
			const modelSelection = loaded.config.provider
				? `${loaded.config.provider}/${loaded.config.model}`
				: undefined;
			const value = { ...loaded.config, modelSelection };
			return {
				value,
				async apply(value, signal) {
					if (!ctx.isIdle()) {
						throw new Error("Wait for the agent to finish before changing quality settings");
					}
					const { modelSelection, ...settings } = value;
					const model = ctx.modelRegistry
						.getAvailable()
						.find((model) => `${model.provider}/${model.id}` === modelSelection);
					if (modelSelection && !model) {
						throw new Error("Select an available quality reviewer");
					}
					await runtime.applySettings(
						ctx,
						{ ...settings, provider: model?.provider, model: model?.id },
						signal,
						settingsFormConfigRevision,
					);
					await restartDry(ctx);
					await lsp?.stop();
					lspStartup = lsp?.start(ctx.cwd, ctx.isProjectTrusted(), runtime.active) ?? Promise.resolve();
					await lspStartup;
				},
			};
		},
	});
	const setupLspAction = {
		id: "setup",
		label: "Language server setup wizard",
		async run(ctx: ExtensionContext, signal: AbortSignal) {
			if (!lsp || runtime.pending) {
				throw new Error("Resolve pending quality work before configuring LSPs");
			}
			const project = await resolveLspProject(ctx.cwd, agentDir);
			const approved = await setupSandboxLsp({
				pi,
				ctx: settingsFlowContext(ctx, signal),
				agentDir,
				project,
				mode: "setup",
				activation: "editor-save",
				signal,
				ports: {
					validate: (route, owner, operationSignal) => lsp!.validate(route, owner, operationSignal),
					progress: (text) => ctx.ui.setStatus("quality-lsp-setup", text),
				},
			});
			if (approved) {
				await lsp.stop();
				lspStartup = lsp.start(ctx.cwd, ctx.isProjectTrusted(), runtime.active);
				await lspStartup;
			}
		},
	};
	registerSettingsSection(pi, {
		plugin: qualityPlugin,
		id: "lsp",
		title: "Language Servers",
		description: "Automatic routing and project-specific LSP overrides",
		effect: "Validated LSP overrides applied to this project. No software is installed.",
		fields: [
			{ path: "enabled", label: "Enabled for this project", kind: "boolean" },
			{ path: "mode", label: "Route mode", kind: "string", choices: ["auto", "explicit"] },
			{ path: "disabledLanguages", label: "Disabled automatic languages", kind: "json" },
			{ path: "routes", label: "Routes, settings, roots, and timeouts", kind: "json" },
		],
		async load(ctx) {
			const project = await resolveLspProject(ctx.cwd, agentDir);
			const stored = await loadLspProfile(agentDir, project);
			const pendingDraft = await loadLspDraft(agentDir, project);
			let ownedDraftRevision = pendingDraft?.revision ?? null;
			const baseRevision = pendingDraft ? pendingDraft.draft.baseRevision : (stored?.revision ?? null);
			const value = pendingDraft?.draft.profile ??
				stored?.profile ?? {
					version: 1,
					projectId: project.id,
					enabled: true,
					mode: "auto",
					routes: [],
					disabledLanguages: [],
				};
			return {
				value: { ...value },
				async apply(next, signal = new AbortController().signal) {
					if (!ctx.isIdle() || runtime.pending) {
						throw new Error("Resolve the pending quality case before changing LSP coverage");
					}
					if (!lsp) {
						throw new Error("Language server manager is unavailable");
					}
					const profile = parseLspProfile(next, project.id);
					const publication = await publishLspDraft(
						agentDir,
						project,
						profile,
						baseRevision,
						ownedDraftRevision,
					);
					ownedDraftRevision = publication.revision;
					await validateAndActivateLspDraft(
						ctx,
						agentDir,
						project,
						{
							validate: (route, owner, signal) => lsp!.validate(route, owner, signal),
							progress: (text) => ctx.ui.setStatus("quality-lsp-setup", text),
						},
						signal,
						publication.revision,
					);
					await lsp.stop();
					lspStartup = lsp.start(ctx.cwd, ctx.isProjectTrusted(), runtime.active);
					await lspStartup;
					lspSetupError = undefined;
				},
			};
		},
		actions: [setupLspAction],
	});
	registerSettingsSection(pi, {
		plugin: qualityPlugin,
		id: "quality-dry",
		title: "DRY Checking",
		description: "Shared reviewer and fresh repository clone retrieval",
		effect:
			"DRY settings applied; every check scans current sources and pending case decisions remain explicit.",
		fields: [
			{
				path: "dryEnabled",
				label: "Enabled",
				kind: "boolean",
				edit: async (ctx, current, signal) => {
					await handleDryCommand(current ? "off" : "on", ctx, dryCommandPorts(), signal);
					return { value: runtime.config.dryEnabled };
				},
			},
			{ path: "dryScanTimeoutMs", label: "Scan timeout (ms)", kind: "number" },
			{ path: "dryMaxInputChars", label: "Reviewer input characters", kind: "number" },
			{ path: "dryMaxOutputTokens", label: "Reviewer output tokens", kind: "number" },
			{ path: "profile", label: "Project retrieval profile", kind: "json" },
		],
		async load(ctx) {
			const project = await resolveDryProject(ctx.cwd, agentDir);
			const stored = await loadDryProfile(agentDir, project);
			let profileRevision = stored.revision;
			const settingsValue = { ...runtime.config, profile: stored.profile };
			return {
				value: settingsValue,
				async apply(value, signal = new AbortController().signal) {
					const { profile, ...config } = value;
					const validatedProfile = parseDryProfile(profile);
					await runtime.applySettings(ctx, config, signal);
					await saveDryProfile(agentDir, project, validatedProfile, profileRevision);
					profileRevision = (await loadDryProfile(agentDir, project)).revision;
					await restartDry(ctx);
				},
			};
		},
		actions: [
			{
				id: "status",
				label: "Show status",
				run: (ctx, signal) => handleDryCommand("status", ctx, dryCommandPorts(), signal),
			},
			{
				id: "refresh",
				label: "Run fresh scan",
				run: (ctx, signal) => handleDryCommand("refresh", ctx, dryCommandPorts(), signal),
			},
		],
	});
	pi.registerMessageRenderer("code-quality:feedback", feedbackRenderer);
	pi.registerEntryRenderer(
		QUALITY_CHECK_ENTRY,
		createCheckingRenderer((id) => runtime.checkDisplay(id)),
	);
	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		sessionAbort = new AbortController();
		lspSetupError = undefined;
		activity?.dispose();
		activity = ctx.mode === "tui" ? createQualityActivityPublisher(pi.events) : undefined;
		runtime.ports.activity = activity;
		runtime.ports.filesystem = {
			canonical: (path, signal) => qualitySandbox(pi).session.filesystem.canonical(path, signal),
			snapshot: (path, config, authorized, signal) =>
				readGuestSnapshot(qualitySandbox(pi), path, config, authorized, signal),
		};
		await runtime.start(ctx);
		pi.events.emit("sandbox:discover:v1", { version: 1 });
		if (ctx.mode === "tui") {
			const updateDryStatus = () => activity?.updateDry?.(dry!.status);
			dry = ports.createDryManager?.(updateDryStatus) ?? new SandboxDryManager(pi, agentDir, updateDryStatus);
			const dryGate = createDryGate(dry);
			runtime.ports.dry = ports.dry ?? {
				get revision() {
					return dryGate.revision;
				},
				get configRevision() {
					return dryGate.configRevision;
				},
				current: (signal) => dryGate.current(signal),
				check: async (request) => {
					await dryStartup.catch(() => {});
					return dryGate.check(request);
				},
			};
			dryStartup = restartDry(ctx);
			dryStartup.catch(() => {});
			const updateLspStatus = () => {
				activity?.updateLsp(lsp?.header ?? []);
				if (context) context.ui.setStatus("quality-lsp", lsp?.statusText());
			};
			const isProjectTrusted = () => context?.isProjectTrusted() === true;
			lsp =
				ports.createLspManager?.(updateLspStatus) ??
				new SandboxLspManager(pi, agentDir, updateLspStatus, isProjectTrusted);
			const checkFilesAfterStartup: SandboxLspManager["check"] = async (files, signal, onStart) => {
				const manager = lsp!;
				await lspStartup;
				signal.throwIfAborted();
				return manager.check(files, signal, onStart);
			};
			runtime.ports.lsp = {
				check: checkFilesAfterStartup,
				refreshWorkspace: async (signal) => {
					if (lsp instanceof SandboxLspManager) {
						await lsp.refreshWorkspace(signal);
					}
				},
				restart: async (id, signal) => {
					await lsp!.restart(id, signal);
					signal.throwIfAborted();
					lspStartup = lsp!.start(ctx.cwd, ctx.isProjectTrusted(), runtime.active);
					await lspStartup;
					lspSetupError = undefined;
				},
				get revision() {
					return lsp?.revision ?? 0;
				},
				get configRevision() {
					return lsp?.configRevision ?? "unconfigured";
				},
			};
			lspStartup = lsp.start(ctx.cwd, ctx.isProjectTrusted(), runtime.active);
			const startupOwner = sessionAbort;
			lspStartup.catch((error) => {
				if (startupOwner.signal.aborted || context !== ctx) {
					return;
				}
				lspSetupError = String(error);
				try {
					ctx.ui.notify(`LSP setup unavailable: ${lspSetupError}`, "warning");
				} catch {
					return;
				}
			});
		}
	});
	const suspendForSandboxOff = async (ctx: ExtensionContext): Promise<void> => {
		runtime.suspendForSandboxOff(ctx);
		await dry?.stop();
		await lspStartup.catch(() => {});
		await lsp?.stop();
		lspSetupError = undefined;
	};
	const resumeAfterSandbox = async (ctx: ExtensionContext): Promise<void> => {
		runtime.resumeAfterSandbox(ctx);
		if (!runtime.active) {
			return;
		}
		await restartDry(ctx);
		lspStartup = lsp?.start(ctx.cwd, ctx.isProjectTrusted(), runtime.active) ?? Promise.resolve();
		await lspStartup;
	};
	const unsubscribeSandboxState = pi.events.on("sandbox:state:v1", (raw) => {
		const state = raw as { phase?: string; sessionId?: string };
		const isCurrentSession = Boolean(context && state.sessionId === context.sessionManager.getSessionId());
		if (isCurrentSession && state.phase === "off") {
			void suspendForSandboxOff(context!).catch(() => {});
			return;
		}
		if (isCurrentSession && state.phase === "ready" && runtime.sandboxSuspended) {
			void resumeAfterSandbox(context!).catch(() => {});
			return;
		}
		if (
			state.phase === "ready" &&
			context &&
			state.sessionId === context.sessionManager.getSessionId() &&
			dry?.status.toolPhase !== "ready" &&
			!dryRestartPending
		) {
			dryStartup = restartDry(context);
			dryStartup.catch(() => {});
		}
	});
	pi.on("session_tree", async (_event, ctx) => {
		sessionAbort.abort();
		sessionAbort = new AbortController();
		await runtime.start(ctx);
		activity?.updateLsp(lsp?.header ?? []);
		if (dry) {
			void dry
				.stop()
				.then(() => restartDry(ctx))
				.catch(() => {});
		}
	});
	pi.on("session_shutdown", async () => {
		sessionAbort.abort();
		unsubscribeSandboxState();
		context = undefined;
		runtime.dispose();
		await dry?.stop();
		await dryStartup.catch(() => {});
		dry = undefined;
		runtime.ports.dry = undefined;
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
	pi.on("turn_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !runtime.active || !runtime.config.dryEnabled || ports.dry) {
			return;
		}
		const owner = sessionAbort;
		const manager = dry;
		void dryStartup
			.then(async () => {
				if (owner.signal.aborted || dry !== manager || !manager) {
					return;
				}
				const signal = ctx.signal ? AbortSignal.any([ctx.signal, owner.signal]) : owner.signal;
				await manager.beginTurn(signal);
			})
			.catch(() => {});
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
						text: `LSP unavailable: ${lspSetupError}. Check sandbox provisioning or use /quality lsp doctor.`,
					},
				],
				details: event.details,
				usage: event.usage,
				isError: event.isError,
			};
		}
		const path = await qualitySandbox(pi).session.filesystem.canonical(event.input.path, ctx.signal);
		const snapshot = runtime.state?.files.find((file) => file.path === path);
		if (!snapshot) return;
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, owner.signal]) : owner.signal;
		let after: string | null;
		try {
			after = await readGuestSnapshot(
				qualitySandbox(pi),
				path,
				runtime.config,
				runtime.state?.authorized.includes(path) ?? false,
				ctx.signal,
			);
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
		exposure: "model-only",
		label: "Quality response",
		description:
			"Send a bounded disagreement to the quality reviewer for reconsideration. Corrections and disagreements share five review rounds before automatic operator arbitration. Cannot approve, disable, or waive a review.",
		executionMode: "sequential",
		parameters: Type.Object({
			action: Type.Literal("disagree"),
			caseId: Type.String(),
			revision: Type.String(),
			rationale: Type.String({ minLength: 1, maxLength: 2000 }),
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
			if (action === "dry" || action.startsWith("dry ")) {
				if (action !== "dry" && action !== "dry status") {
					await ctx.waitForIdle();
				}
				await handleDryCommand(action.slice(3).trim(), ctx, dryCommandPorts(), sessionAbort.signal);
				return;
			}
			if (action === "lsp" || action.startsWith("lsp ")) {
				if (!lsp) {
					ctx.ui.notify("LSP quality requires TUI mode", "warning");
					return;
				}
				if (action !== "lsp" && action !== "lsp status") await ctx.waitForIdle();
				const statusOnly = action === "lsp" || action === "lsp status";
				await lspStartup.catch(() => {});
				const finishAttention = statusOnly ? undefined : activity?.requestDecision("lsp_setup");
				try {
					await handleLspCommand(
						action.slice(3).trim(),
						ctx,
						agentDir,
						{
							setup: (mode, project, signal) => {
								const setupPorts: LspSetupPorts = {
									validate: (route, project, signal) => lsp!.validate(route, project, signal),
									progress: (text) => ctx.ui.setStatus("quality-lsp-setup", text),
								};
								return setupSandboxLsp({ pi, ctx, agentDir, project, mode, signal, ports: setupPorts });
							},
							status: () => lsp!.statusText(),
							effectiveRoutes: () => (lsp instanceof SandboxLspManager ? lsp.effectiveRoutes() : []),
							validate: (route, project, signal) => lsp!.validate(route, project, signal),
							progress: (text) => ctx.ui.setStatus("quality-lsp-setup", text.slice(-200)),
							restart: (id, signal) => lsp!.restart(id, signal),
							reload: async () => {
								await lsp!.stop();
								lspStartup = lsp!.start(ctx.cwd, ctx.isProjectTrusted(), runtime.active);
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
			if ((action === "off" && !runtime.active) || (action === "on" && runtime.active)) {
				await restartDry(ctx);
				await lsp?.stop();
				lspStartup = lsp?.start(ctx.cwd, ctx.isProjectTrusted(), runtime.active) ?? Promise.resolve();
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
