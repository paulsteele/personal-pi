import {
	type ExtensionAPI,
	type ExtensionContext,
	estimateTokens,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { createFooterComponent, type ThemeLike } from "../src/footer.js";
import {
	createPlannotatorIntegration,
	PLANNOTATOR_PANEL_ID,
	plannotatorPanel,
	type PlannotatorIntegration,
} from "../src/plannotator.js";
import { createRunActivityTracker, type RunActivityTracker } from "../src/run-activity.js";
import {
	buildSidebarSnapshot,
	createSidebarController,
	type SidebarController,
	type SidebarSnapshot,
} from "../src/sidebar.js";
import { createSidebarPanelRegistry, type SidebarPanelRegistry } from "../src/sidebar-panels.js";
import { AtelierRuntime, createInertAtelierState } from "../src/state.js";
import { type AtelierConfig, type AtelierState, DEFAULT_CONFIG, type FooterState } from "../src/types.js";

export type {
	SidebarPanelContribution,
	SidebarPanelData,
	SidebarPanelDiscoveryEvent,
	SidebarPanelEvent,
	SidebarPanelEventTransport,
	SidebarPanelRegisterEvent,
	SidebarPanelRegistry,
	SidebarPanelRegistryOptions,
	SidebarPanelRole,
	SidebarPanelRow,
	SidebarPanelUnregisterEvent,
} from "../src/sidebar-panels.js";
export {
	BUILTIN_SIDEBAR_PANEL_IDS,
	createSidebarPanelRegistry,
	isSidebarPanelContributionId,
	isSidebarPanelId,
	isSidebarPanelRequestId,
	isSidebarPanelRole,
	isSidebarPanelSource,
	isSidebarPanelTextWithinRawLimit,
	registerSidebarPanel,
	SIDEBAR_PANEL_EVENT_CHANNEL,
	SIDEBAR_PANEL_MAX_ID_CHARS,
	SIDEBAR_PANEL_MAX_PANELS,
	SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS,
	SIDEBAR_PANEL_MAX_RAW_ROW_CODE_UNITS,
	SIDEBAR_PANEL_MAX_RAW_TITLE_CODE_UNITS,
	SIDEBAR_PANEL_MAX_ROW_CHARS,
	SIDEBAR_PANEL_MAX_ROWS,
	SIDEBAR_PANEL_MAX_SOURCE_CHARS,
	SIDEBAR_PANEL_MAX_TITLE_CHARS,
	SIDEBAR_PANEL_MAX_TRACKED_SOURCES,
	SIDEBAR_PANEL_PROTOCOL_VERSION,
} from "../src/sidebar-panels.js";
export type { BuiltinSidebarPanelId, ContributedSidebarPanelId, SidebarPanelId } from "../src/types.js";

interface ActiveSession {
	readonly ctx: ExtensionContext;
	readonly sessionManager: ExtensionContext["sessionManager"];
	readonly token: LifecycleToken;
	readonly runtime: AtelierRuntime;
	readonly sidebar: SidebarController;
	readonly panelRegistry: SidebarPanelRegistry;
	readonly runActivity: RunActivityTracker;
	readonly plannotator: PlannotatorIntegration;
	readonly retiredState: AtelierState;
	readonly retiredConfig: AtelierConfig;
	readonly retiredCwd: string;
	footerDisposer: (() => void) | undefined;
	footerGeneration: number;
	retired: boolean;
	requestFooterRender: () => void;
	extensionStatuses: readonly string[];
}

interface LifecycleToken {
	readonly id: number;
}

export default function atelierExtension(pi: ExtensionAPI): void {
	const noopRender = (): void => undefined;
	let activeSession: ActiveSession | undefined;
	let resizeShortcutRegistered = false;
	let lifecycleToken: LifecycleToken = { id: 0 };
	let initializingSessionManager: ExtensionContext["sessionManager"] | undefined;

	/** Retires the current lifecycle and records which initialization, if any, is now in flight. */
	function startLifecycleGeneration(
		sessionManagerClaim: ExtensionContext["sessionManager"] | undefined,
	): LifecycleToken {
		lifecycleToken = { id: lifecycleToken.id + 1 };
		initializingSessionManager = sessionManagerClaim;
		return lifecycleToken;
	}

	const requestAllRenders = (targetSession: ActiveSession): void => {
		if (activeSession !== targetSession) return;
		targetSession.requestFooterRender();
		targetSession.sidebar.requestRender();
	};

	function updateExtensionStatuses(targetSession: ActiveSession, next: readonly string[]): void {
		if (activeSession !== targetSession) return;
		if (
			next.length === targetSession.extensionStatuses.length &&
			next.every((status, index) => status === targetSession.extensionStatuses[index])
		) {
			return;
		}
		targetSession.extensionStatuses = [...next];
		targetSession.sidebar.requestRender();
	}

	function syncPlannotatorPanel(targetSession: ActiveSession): void {
		if (activeSession !== targetSession || targetSession.retired) return;
		const snapshot = targetSession.plannotator.getSnapshot(targetSession.ctx);
		if (snapshot) targetSession.panelRegistry.register(plannotatorPanel(snapshot), "plannotator");
		else targetSession.panelRegistry.unregister(PLANNOTATOR_PANEL_ID, "plannotator");
	}

	function refreshPlannotator(targetSession: ActiveSession): void {
		try {
			syncPlannotatorPanel(targetSession);
			targetSession.requestFooterRender();
			targetSession.sidebar.requestRender();
		} catch {
			// Plannotator integration is optional; a stale/broken branch must not
			// interrupt Atelier lifecycle or sidebar error handling.
		}
	}

	function schedulePlannotatorRefresh(targetSession: ActiveSession): void {
		targetSession.plannotator.scheduleRefresh(targetSession.ctx, () => refreshPlannotator(targetSession));
	}

	function getSidebarSnapshot(targetSession: ActiveSession): SidebarSnapshot {
		if (targetSession.retired || activeSession !== targetSession) {
			return buildSidebarSnapshot({
				state: targetSession.retiredState,
				cwd: targetSession.retiredCwd,
				branchEntryCount: 0,
				extensionStatuses: [],
				sidebarPanels: [],
			});
		}
		const { ctx, panelRegistry, runActivity, runtime } = targetSession;
		// Plannotator's own setStatus call requests a render on phase transitions;
		// deriving the panel here makes that render immediately reflect the latest
		// durable branch even though Pi has no generic extension-command-end event.
		syncPlannotatorPanel(targetSession);
		const sessionName = ctx.sessionManager.getSessionName();
		const sessionFile = ctx.sessionManager.getSessionFile();
		return buildSidebarSnapshot({
			state: runtime.getState(),
			cwd: ctx.cwd,
			...(sessionName ? { sessionName } : {}),
			...(sessionFile ? { sessionFile } : {}),
			branchEntryCount: ctx.sessionManager.getBranch().length,
			extensionStatuses: targetSession.extensionStatuses,
			runActivity: runActivity.getSnapshot(),
			sidebarPanels: panelRegistry.getAvailable(),
		});
	}

	function contextUsesSessionManager(
		ctx: ExtensionContext | undefined,
		sessionManager: ExtensionContext["sessionManager"],
	): boolean {
		if (!ctx) return false;
		try {
			return ctx.sessionManager === sessionManager;
		} catch {
			return false;
		}
	}

	function getActiveSession(ctx: ExtensionContext | undefined): ActiveSession | undefined {
		const current = activeSession;
		return current && contextUsesSessionManager(ctx, current.sessionManager) ? current : undefined;
	}

	function clearFooter(session: ActiveSession, shouldClear: boolean): void {
		// Invalidate callbacks before touching Pi so a failed removal cannot leave a live footer.
		session.footerGeneration += 1;
		const footerDisposer = session.footerDisposer;
		session.footerDisposer = undefined;
		if (shouldClear) {
			try {
				session.ctx.ui.setFooter(undefined);
			} catch {
				// Pi may retain the old footer when removal fails; dispose it below regardless.
			}
		}
		try {
			footerDisposer?.();
		} catch {
			// Footer disposal is best-effort and must not mask session teardown.
		}
	}

	/**
	 * Retirement is decided by session identity, so cleanup is best-effort: every owned
	 * resource gets a release attempt even if another disposer throws.
	 */
	function disposeSession(session: ActiveSession, options: { clearFooter?: boolean } = {}): void {
		session.retired = true;
		session.extensionStatuses = [];
		session.requestFooterRender = noopRender;
		const cleanup = (action: () => void): void => {
			try {
				action();
			} catch {
				// Teardown must not leak later resources or replace the original failure.
			}
		};
		clearFooter(session, options.clearFooter === true);
		cleanup(() => session.sidebar.dispose());
		cleanup(() => session.panelRegistry.dispose());
		cleanup(() => session.runtime.dispose());
		cleanup(() => session.runActivity.reset());
		cleanup(() => session.plannotator.dispose());
	}

	function teardownActiveSession(ctx?: ExtensionContext): void {
		const retiredSession = activeSession;
		activeSession = undefined;
		if (retiredSession) disposeSession(retiredSession, { clearFooter: true });
		else {
			try {
				ctx?.ui.setFooter(undefined);
			} catch {
				// No-active cleanup must not mask the original lifecycle failure.
			}
		}
	}

	function installFooter(targetSession: ActiveSession): void {
		const { ctx } = targetSession;
		const token = targetSession.token;
		const generation = ++targetSession.footerGeneration;
		const retiredState = targetSession.retiredState;
		const retiredConfig = targetSession.retiredConfig;
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const getCurrentSession = (): ActiveSession | undefined => {
				const current = activeSession;
				return current?.token === token && current.footerGeneration === generation ? current : undefined;
			};
			const footerRequestRender = (): void => {
				if (getCurrentSession()) tui.requestRender();
			};
			const current = getCurrentSession();
			if (current) current.requestFooterRender = footerRequestRender;
			const component = createFooterComponent({
				getState: (): FooterState => {
					// A footer outliving its `setFooter(undefined)` reports detached inert state.
					const currentSession = getCurrentSession();
					if (!currentSession) return retiredState;
					const branch = footerData.getGitBranch();
					const statuses = footerData.getExtensionStatuses();
					const plannotatorStatus = statuses.get("plannotator");
					updateExtensionStatuses(
						currentSession,
						Array.from(statuses.entries())
							.filter(([key]) => key !== "plannotator")
							.map(([, value]) => value),
					);
					const performance = currentSession.runActivity.getSnapshot().performance;
					return {
						...currentSession.runtime.getState(),
						...(branch ? { branch } : {}),
						...(performance ? { performance } : {}),
						...(plannotatorStatus ? { plannotatorStatus } : {}),
						extensionStatuses: currentSession.extensionStatuses,
					};
				},
				getConfig: () => retiredConfig,
				isSidebarPresented: () => getCurrentSession()?.sidebar.isPresented() ?? false,
				colorEnabled: !("NO_COLOR" in process.env),
				requestRender: footerRequestRender,
				onBranchChange: (callback) =>
					footerData.onBranchChange(() => {
						const currentSession = getCurrentSession();
						if (!currentSession) return;
						void currentSession.runtime.flushWorkspacePulseRefresh();
						callback();
					}),
				theme: theme as unknown as ThemeLike,
			});
			const mounted = getCurrentSession();
			if (mounted) mounted.footerDisposer = component.dispose;
			else component.dispose();
			return component;
		});
	}

	pi.registerCommand("atelier", {
		description: "Toggle the Pi Atelier sidebar",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Pi Atelier sidebar requires TUI mode", "warning");
				return;
			}
			const current = getActiveSession(ctx);
			if (!current) {
				ctx.ui.notify("Pi Atelier is not active in this session", "warning");
				return;
			}
			const action = args.trim().toLowerCase();
			if (action === "" || action === "toggle") current.sidebar.toggle();
			else if (action === "on") current.sidebar.show();
			else if (action === "off") current.sidebar.hide();
			else ctx.ui.notify("Usage: /atelier [on|off|toggle]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const initializationContext = ctx;
		if (initializationContext.mode !== "tui") {
			startLifecycleGeneration(undefined);
			if (activeSession) teardownActiveSession();
			return;
		}
		const initializationSessionManager = initializationContext.sessionManager;
		const initializationToken = startLifecycleGeneration(initializationSessionManager);

		let localRuntime: AtelierRuntime | undefined;
		let localSidebar: SidebarController | undefined;
		let localPanelRegistry: SidebarPanelRegistry | undefined;
		let candidateSession: ActiveSession | undefined;
		let publishedSession: ActiveSession | undefined;
		const isFresh = (): boolean => initializationToken === lifecycleToken;
		const requestCandidateRenders = (): void => {
			const current = activeSession;
			if (current?.token === initializationToken) requestAllRenders(current);
		};
		const localPlannotator = createPlannotatorIntegration();
		const localRunActivity = createRunActivityTracker({
			cwd: initializationContext.cwd,
			onChange: requestCandidateRenders,
		});
		try {
			const config = structuredClone(DEFAULT_CONFIG);
			if (!isFresh()) return;
			let autoCompact: boolean | null = null;
			try {
				autoCompact = SettingsManager.create(
					initializationContext.isProjectTrusted() ? initializationContext.cwd : getAgentDir(),
				).getCompactionSettings().enabled;
			} catch {
				initializationContext.ui.notify(
					"Could not read Pi compaction settings; compaction mode is unavailable",
					"warning",
				);
			}
			const candidateRuntime = new AtelierRuntime({
				pi,
				ctx: initializationContext,
				autoCompact,
				requestRender: requestCandidateRenders,
			});
			localRuntime = candidateRuntime;
			localPanelRegistry = createSidebarPanelRegistry({
				events: pi.events,
				instanceId: `atelier-${initializationToken.id}`,
				onChange: requestCandidateRenders,
			});
			localSidebar = createSidebarController({
				ctx: initializationContext,
				getSnapshot: () => {
					const current = activeSession;
					if (!current || current.token !== initializationToken)
						throw new Error("Pi Atelier session is not published");
					return getSidebarSnapshot(current);
				},
				getConfig: () => DEFAULT_CONFIG,
				colorEnabled: !("NO_COLOR" in process.env),
				shouldAnimate: () => activeSession?.token === initializationToken && localRunActivity.isRunning(),
				onPresentationChange: requestCandidateRenders,
				onWarning: (message) => initializationContext.ui.notify(message, "warning"),
				onError: (error) =>
					initializationContext.ui.notify(
						`Pi Atelier sidebar failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					),
			});
			if (!isFresh()) {
				localSidebar.dispose();
				localPanelRegistry?.dispose();
				localRunActivity.reset();
				localPlannotator.dispose();
				candidateRuntime.dispose();
				return;
			}

			const nextSession: ActiveSession = {
				ctx: initializationContext,
				sessionManager: initializationContext.sessionManager,
				token: initializationToken,
				runtime: candidateRuntime,
				sidebar: localSidebar,
				panelRegistry: localPanelRegistry,
				runActivity: localRunActivity,
				plannotator: localPlannotator,
				retiredState: createInertAtelierState(autoCompact),
				retiredConfig: DEFAULT_CONFIG,
				retiredCwd: initializationContext.cwd,
				footerDisposer: undefined,
				footerGeneration: 0,
				retired: false,
				requestFooterRender: noopRender,
				extensionStatuses: [],
			};
			candidateSession = nextSession;
			if (!isFresh()) {
				disposeSession(nextSession);
				return;
			}
			const previousSession = activeSession;
			activeSession = nextSession;
			publishedSession = nextSession;
			if (previousSession) disposeSession(previousSession, { clearFooter: true });

			if (isFresh() && !resizeShortcutRegistered) {
				pi.registerShortcut("ctrl+shift+r" as KeyId, {
					description: "Resize Pi Atelier sidebar",
					handler: (shortcutContext) => {
						const current = getActiveSession(shortcutContext);
						if (!current?.sidebar.isVisible()) {
							shortcutContext.ui.notify("Show the Pi Atelier sidebar before resizing it", "warning");
							return;
						}
						current.sidebar.beginResize();
					},
				});
				resizeShortcutRegistered = true;
			}
			if (isFresh() && activeSession === nextSession) {
				installFooter(nextSession);
				nextSession.sidebar.show();
			}
			schedulePlannotatorRefresh(nextSession);
			void candidateRuntime.flushWorkspacePulseRefresh();
		} catch (error) {
			const cleanup = (action: () => void): void => {
				try {
					action();
				} catch {
					// Preserve the initialization failure and keep attempting candidate cleanup.
				}
			};
			if (!publishedSession) {
				// Candidate-local cleanup: this session never became active, so no active-session teardown applies.
				if (candidateSession) disposeSession(candidateSession);
				else {
					const sidebar = localSidebar;
					const panelRegistry = localPanelRegistry;
					const runtime = localRuntime;
					if (sidebar) cleanup(() => sidebar.dispose());
					if (panelRegistry) cleanup(() => panelRegistry.dispose());
					cleanup(() => localRunActivity.reset());
					cleanup(() => localPlannotator.dispose());
					if (runtime) cleanup(() => runtime.dispose());
				}
				if (!isFresh()) return;
				initializationContext.ui.notify(
					`Pi Atelier could not start: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			if (!isFresh()) return;
			if (activeSession !== publishedSession) return;
			teardownActiveSession(initializationContext);
			initializationContext.ui.notify(
				`Pi Atelier could not start: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		} finally {
			if (lifecycleToken === initializationToken) initializingSessionManager = undefined;
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		schedulePlannotatorRefresh(current);
		requestAllRenders(current);
	});

	pi.on("agent_start", (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runActivity.startRun();
		current.runtime.setActivity("working");
	});
	pi.on("turn_start", (event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runActivity.startTurn(event.turnIndex);
		current.runtime.scheduleWorkspacePulseRefresh();
	});
	pi.on("before_provider_request", (_event, ctx) => {
		getActiveSession(ctx)?.runActivity.startResponse();
	});
	pi.on("message_update", (event, ctx) => {
		const estimatedOutputTokens = estimateTokens(event.message);
		if (estimatedOutputTokens <= 0) return;
		getActiveSession(ctx)?.runActivity.updateResponseEstimate(estimatedOutputTokens);
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		getActiveSession(ctx)?.runActivity.finishResponse(event.message.usage.output);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runActivity.startTool(event);
		current.plannotator.onToolStart(event, ctx);
		schedulePlannotatorRefresh(current);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runActivity.finishTool(event);
		current.plannotator.onToolEnd(event, ctx);
		schedulePlannotatorRefresh(current);
		current.runtime.scheduleWorkspacePulseRefresh();
	});
	pi.on("agent_end", (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (current) schedulePlannotatorRefresh(current);
	});
	pi.on("agent_settled", (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current || !ctx.isIdle()) return;
		current.runActivity.settle();
		current.runtime.setActivity("ready");
		current.sidebar.requestRender();
	});
	pi.on("turn_end", async (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		schedulePlannotatorRefresh(current);
		current.runtime.refreshUsage();
		await current.runtime.flushWorkspacePulseRefresh();
	});
	pi.on("model_select", (_event, ctx) => getActiveSession(ctx)?.runtime.refreshUsage());
	pi.on("thinking_level_select", (_event, ctx) => getActiveSession(ctx)?.runtime.refreshUsage());
	pi.on("session_compact", (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		schedulePlannotatorRefresh(current);
		current.runtime.refreshUsage();
	});
	pi.on("session_info_changed", (_event, ctx) => getActiveSession(ctx)?.runtime.refreshUsage());
	pi.on("session_shutdown", (_event, ctx) => {
		const current = getActiveSession(ctx);
		const initializing = initializingSessionManager;
		const cancelsInitialization = initializing !== undefined && contextUsesSessionManager(ctx, initializing);
		if (initializing && !cancelsInitialization) {
			// An unrelated session is shutting down; retire it but leave the newer initializer authoritative.
			if (current) teardownActiveSession();
			return;
		}
		if (!current && activeSession !== undefined && !cancelsInitialization) return;
		startLifecycleGeneration(undefined);
		if (current) teardownActiveSession();
	});
}
