import type { WorkspacePulseData } from "./workspace-pulse.js";

export type ActivityState = "ready" | "working";
export type BuiltinSidebarPanelId = "agent" | "activity" | "alerts" | "context" | "workspace" | "usage";
/** Stable namespaced IDs are used by contributed panels. */
export type ContributedSidebarPanelId = `${string}:${string}`;
export type SidebarPanelId = BuiltinSidebarPanelId | ContributedSidebarPanelId;
export type ProgressObserverPhase = "waiting" | "observing" | "ready" | "error" | "disabled" | "unavailable";

export interface ProgressObserverSummary {
	goal: string;
	progress: string;
	current: string;
	next?: string;
	blockers?: string;
}

export interface ProgressObserverSnapshot {
	phase: ProgressObserverPhase;
	modelId: string;
	updatedAt?: number;
	stale?: boolean;
	message?: string;
	summary?: ProgressObserverSummary;
}

export interface ResponsePerformance {
	ttftMs: number;
	tokensPerSecond?: number;
	estimated?: true;
}

export interface DisplayValue {
	text: string;
	available: boolean;
}

export const CONTEXT_WARNING_PERCENT = 70;
export const CONTEXT_DANGER_PERCENT = 90;
export const CURRENCY_DECIMALS = 3;

export interface AtelierMetrics {
	usageAvailable: boolean;
	costAvailable: boolean;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheHitPercent?: number;
	cost: number;
	subscription: boolean;
	contextTokens: number | null;
	contextWindow: number;
	contextPercent: number | null;
	autoCompact: boolean | null;
}

export type WorkspacePulseState =
	| { status: "inspecting" }
	| { status: "clean" | "changed" | "conflict" | "stale"; data: WorkspacePulseData }
	| { status: "not-repo" | "unavailable" };

export interface AtelierState {
	activity: ActivityState;
	modelId?: string;
	provider?: string;
	thinkingLevel?: string;
	branch?: string;
	dirty: boolean;
	workspacePulse: WorkspacePulseState;
	metrics: AtelierMetrics;
	extensionStatuses: readonly string[];
}

export interface FooterPanelSummary {
	id: ContributedSidebarPanelId;
	title: string;
	summary?: string;
}

/** Footer render input: runtime state plus session and integration metadata. */
export interface FooterState extends AtelierState {
	performance?: ResponsePerformance;
	projectName?: string;
	sessionName?: string;
	persisted?: boolean;
	branchEntryCount?: number;
	panelSummaries?: readonly FooterPanelSummary[];
	plannotatorStatus?: string;
	/**
	 * Compact auto-mode label (`⏵⏵ auto`), published by the local
	 * auto-mode extension. Present only while auto mode is armed, so a manual
	 * session's rail is unchanged.
	 */
	autoModeStatus?: string;
}
