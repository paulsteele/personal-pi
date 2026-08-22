import type { WorkspacePulseData } from "./workspace-pulse.js";

export type ActivityState = "ready" | "working" | "warning" | "error";
export type SegmentId =
	| "brand"
	| "activity"
	| "metrics"
	| "performance"
	| "context"
	| "model"
	| "git"
	| "statuses";
export type BuiltinSidebarPanelId =
	| "agent"
	| "activity"
	| "alerts"
	| "todos"
	| "context"
	| "workspace"
	| "usage"
	| "tools";
/** Stable namespaced IDs are used by contributed panels. */
export type ContributedSidebarPanelId = `${string}:${string}`;
export type SidebarPanelId = BuiltinSidebarPanelId | ContributedSidebarPanelId;
export interface SegmentLayoutEntry {
	id: SegmentId;
	visible: boolean;
}
export type SegmentLayout = SegmentLayoutEntry[];

export interface ResponsePerformance {
	ttftMs: number;
	tokensPerSecond?: number;
	estimated?: true;
}

export interface DisplayValue {
	text: string;
	available: boolean;
}

export interface AtelierConfig {
	segmentLayout: SegmentLayout;
	contextWarning: number;
	contextDanger: number;
	currencyDecimals: number;
}

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
	workingLabel?: string;
	modelId?: string;
	provider?: string;
	thinkingLevel?: string;
	branch?: string;
	dirty: boolean;
	workspacePulse: WorkspacePulseState;
	metrics: AtelierMetrics;
	extensionStatuses: readonly string[];
}

/** Footer render input: runtime state plus the live response metrics the runtime does not own. */
export interface FooterState extends AtelierState {
	performance?: ResponsePerformance;
	plannotatorStatus?: string;
}

export const DEFAULT_CONFIG: AtelierConfig = {
	segmentLayout: [
		{ id: "brand", visible: false },
		{ id: "activity", visible: true },
		{ id: "metrics", visible: true },
		{ id: "performance", visible: false },
		{ id: "context", visible: true },
		{ id: "model", visible: true },
		{ id: "git", visible: true },
		{ id: "statuses", visible: true },
	],
	contextWarning: 70,
	contextDanger: 90,
	currencyDecimals: 3,
};
