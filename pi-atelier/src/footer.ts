import {
	type Component,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { formatTokens } from "./metrics.js";
import { type AtelierPalette, createPalette, type PaletteRole } from "./palette.js";
import { responsePerformanceValues } from "./run-activity.js";
import {
	CONTEXT_DANGER_PERCENT,
	CONTEXT_WARNING_PERCENT,
	CURRENCY_DECIMALS,
	type AtelierMetrics,
	type DisplayValue,
	type FooterState,
} from "./types.js";

export interface ThemeLike {
	readonly name?: string;
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
}

type FooterItemId =
	| "auto"
	| "plannotator"
	| "model"
	| "git"
	| "session"
	| "context"
	| "usage"
	| "performance"
	| "alerts"
	| `panel:${string}`;

interface FooterItem {
	id: FooterItemId;
	full: string;
	compact: string;
	dropRank: number;
	required: boolean;
}

const DROP = {
	panels: 0,
	alerts: 5,
	performance: 10,
	session: 20,
	usage: 30,
	git: 40,
	model: 50,
	context: Number.POSITIVE_INFINITY,
} as const;

const ICON = {
	model: "󰒋",
	git: "󰊢",
	session: "󰆍",
	context: "󰍛",
	usage: "󰓅",
	performance: "󰔟",
	alert: "󰀦",
	panel: "󰮯",
} as const;

const sanitize = (text: string): string =>
	text
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

function finiteCount(value: number | undefined): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value ?? 0)) : 0;
}

function paintValue(value: DisplayValue, role: PaletteRole, palette: AtelierPalette): string {
	return palette.paint(value.available ? role : "dim", value.text);
}

function availableValue(available: boolean, value: number): DisplayValue {
	return available && Number.isFinite(value)
		? { text: formatTokens(value), available: true }
		: { text: "—", available: false };
}

function percentValue(value: number | null | undefined, decimals: number): DisplayValue {
	return value !== null && value !== undefined && Number.isFinite(value)
		? { text: `${value.toFixed(decimals)}%`, available: true }
		: { text: "—", available: false };
}

function costValue(metrics: AtelierMetrics, decimals: number): DisplayValue {
	if (!metrics.costAvailable || !Number.isFinite(metrics.cost)) return { text: "$—", available: false };
	return { text: `$${Math.max(0, metrics.cost).toFixed(decimals)}`, available: true };
}

function contextRole(metrics: AtelierMetrics): PaletteRole {
	if (metrics.contextPercent === null || !Number.isFinite(metrics.contextPercent)) return "context";
	if (metrics.contextPercent >= CONTEXT_DANGER_PERCENT) return "error";
	if (metrics.contextPercent >= CONTEXT_WARNING_PERCENT) return "warning";
	return "context";
}

function workspaceText(
	state: FooterState,
	palette: AtelierPalette,
): { full: string; compact: string } | undefined {
	const branch = state.branch ? sanitize(state.branch) : "";
	const project = state.projectName ? sanitize(state.projectName) : "";
	const data = "data" in state.workspacePulse ? state.workspacePulse.data : undefined;
	if (!branch && !project && !data) return undefined;
	const statusRole: PaletteRole =
		state.workspacePulse.status === "conflict"
			? "error"
			: state.workspacePulse.status === "stale" || state.workspacePulse.status === "changed"
				? "warning"
				: "ready";
	const status =
		state.workspacePulse.status === "conflict"
			? "✕"
			: state.workspacePulse.status === "stale"
				? "~"
				: state.workspacePulse.status === "changed"
					? "▲"
					: "";
	const identity = [project, branch]
		.filter(Boolean)
		.map((part) => palette.paint("accent", part))
		.join(" · ");
	const marker = status ? ` ${palette.paint(statusRole, status)}` : "";
	const additions = data ? palette.paint("added", `${finiteCount(data.snapshot.linesAdded)}`) : "";
	const removals = data ? palette.paint("error", `${finiteCount(data.snapshot.linesRemoved)}`) : "";
	const untracked = data?.snapshot.untrackedFiles
		? palette.paint("warning", `?${finiteCount(data.snapshot.untrackedFiles)}`)
		: "";
	const churn = [additions, removals, untracked].filter(Boolean).join(" ");
	const full = `${palette.paint("accent", ICON.git)} ${identity}${marker}${churn ? ` ${churn}` : ""}`;
	const compactIdentity = branch || project || "git";
	return {
		full,
		compact: `${palette.paint("accent", ICON.git)} ${palette.paint("accent", compactIdentity)}${marker}`,
	};
}

function buildItems(state: FooterState, theme: ThemeLike, colorEnabled: boolean): FooterItem[] {
	const palette = createPalette(theme, colorEnabled);
	const items: FooterItem[] = [];
	const add = (item: FooterItem): void => {
		if (!items.some((candidate) => candidate.id === item.id)) items.push(item);
	};

	const autoMode = state.autoModeStatus ? sanitize(stripTerminalSequences(state.autoModeStatus)) : "";
	if (autoMode) {
		const rendered = palette.paint(autoMode.includes("⏵⏵") ? "permissionAuto" : "muted", autoMode);
		add({
			id: "auto",
			full: rendered,
			compact: rendered,
			dropRank: Number.POSITIVE_INFINITY,
			required: true,
		});
	}

	const model = state.modelId ? sanitize(state.modelId) : "";
	if (model) {
		const fullParts = [
			palette.paint("primary", model),
			...(state.provider ? [palette.paint("muted", sanitize(state.provider).toUpperCase())] : []),
			...(state.thinkingLevel ? [palette.paint("working", sanitize(state.thinkingLevel).toUpperCase())] : []),
			palette.paint(
				state.metrics.subscription ? "ready" : "muted",
				state.metrics.subscription ? "SUB" : "METERED",
			),
		];
		add({
			id: "model",
			full: `${palette.paint("primary", ICON.model)} ${fullParts.join(palette.paint("dim", " · "))}`,
			compact: `${palette.paint("primary", ICON.model)} ${palette.paint("primary", model)}`,
			dropRank: DROP.model,
			required: false,
		});
	}

	const workspace = workspaceText(state, palette);
	if (workspace) add({ id: "git", ...workspace, dropRank: DROP.git, required: false });

	if (state.sessionName || state.branchEntryCount !== undefined) {
		const name = state.sessionName ? sanitize(state.sessionName) : "session";
		const count = finiteCount(state.branchEntryCount);
		const persistence = state.persisted === undefined ? "" : state.persisted ? "saved" : "ephemeral";
		add({
			id: "session",
			full: `${palette.paint("accent", ICON.session)} ${palette.paint("primary", name)} ${palette.paint(
				"muted",
				[count ? count : "", persistence].filter(Boolean).join(" · "),
			)}`.trimEnd(),
			compact: `${palette.paint("accent", ICON.session)} ${palette.paint("muted", String(count))}`,
			dropRank: DROP.session,
			required: false,
		});
	}

	const metrics = state.metrics;
	const contextRoleValue = contextRole(metrics);
	const used =
		metrics.contextTokens !== null && Number.isFinite(metrics.contextTokens)
			? formatTokens(metrics.contextTokens)
			: "—";
	const window = metrics.contextWindow > 0 ? formatTokens(metrics.contextWindow) : "—";
	const meterWidth = 10;
	const percent =
		metrics.contextPercent !== null && Number.isFinite(metrics.contextPercent)
			? metrics.contextPercent
			: null;
	const filled =
		percent === null ? 0 : Math.min(meterWidth, Math.max(0, Math.round((percent / 100) * meterWidth)));
	const meter = `${palette.paint("dim", "[")}${palette.paint(contextRoleValue, "■".repeat(filled))}${palette.paint(
		"dim",
		"·".repeat(meterWidth - filled),
	)}${palette.paint("dim", "]")}`;
	add({
		id: "context",
		full: `${palette.paint(contextRoleValue, ICON.context)} ${palette.paint(contextRoleValue, used)} ${meter} ${palette.paint(
			contextRoleValue,
			window,
		)}`,
		compact: `${palette.paint(contextRoleValue, ICON.context)}${palette.paint(contextRoleValue, used)}${meter}${palette.paint(
			contextRoleValue,
			window,
		)}`,
		dropRank: DROP.context,
		required: true,
	});

	const input = paintValue(availableValue(metrics.usageAvailable, metrics.input), "input", palette);
	const output = paintValue(availableValue(metrics.usageAvailable, metrics.output), "output", palette);
	const cacheRead = paintValue(availableValue(metrics.usageAvailable, metrics.cacheRead), "cache", palette);
	const cacheHit = paintValue(percentValue(metrics.cacheHitPercent, 0), "cache", palette);
	const cost = paintValue(costValue(metrics, CURRENCY_DECIMALS), "cost", palette);
	add({
		id: "usage",
		full: `${palette.paint("output", ICON.usage)} ${palette.paint("muted", "in")}${input} ${palette.paint(
			"muted",
			"out",
		)}${output} ${palette.paint("muted", "cache")}${cacheRead}/${cacheHit} ${cost}`,
		compact: `${palette.paint("output", ICON.usage)} ${cost}`,
		dropRank: DROP.usage,
		required: false,
	});

	const performance = responsePerformanceValues(state.performance);
	add({
		id: "performance",
		full: `${palette.paint("output", ICON.performance)} ${paintValue(performance.ttft, "output", palette)} ${palette.paint(
			"dim",
			"·",
		)} ${paintValue(performance.tps, "output", palette)}t/s`,
		compact: `${palette.paint("output", ICON.performance)}${paintValue(performance.tps, "output", palette)}`,
		dropRank: DROP.performance,
		required: false,
	});

	const plannotator = state.plannotatorStatus
		? sanitize(stripTerminalSequences(state.plannotatorStatus))
		: "";
	if (plannotator) {
		const rendered = palette.paint(plannotator.includes("📋") ? "accent" : "warning", plannotator);
		add({
			id: "plannotator",
			full: rendered,
			compact: rendered,
			dropRank: Number.POSITIVE_INFINITY,
			required: true,
		});
	}

	const statuses = state.extensionStatuses.map(sanitize).filter(Boolean);
	if (statuses.length > 0) {
		const rendered = `${palette.paint("warning", ICON.alert)} ${palette.paint("warning", statuses.join(" "))}`;
		add({
			id: "alerts",
			full: rendered,
			compact: palette.paint("warning", ICON.alert),
			dropRank: DROP.alerts,
			required: false,
		});
	}

	for (const panel of state.panelSummaries ?? []) {
		const title = sanitize(panel.title) || panel.id;
		const summary = panel.summary ? sanitize(panel.summary) : "";
		add({
			id: `panel:${panel.id}`,
			full: `${palette.paint("accent", ICON.panel)} ${palette.paint("accent", title)}${
				summary ? ` ${palette.paint("muted", summary)}` : ""
			}`,
			compact: `${palette.paint("accent", ICON.panel)} ${palette.paint("accent", title)}`,
			dropRank: DROP.panels,
			required: false,
		});
	}
	return items;
}

function renderItems(items: readonly FooterItem[], compactIds: ReadonlySet<FooterItemId>): string {
	return items
		.map((item) => (compactIds.has(item.id) ? item.compact : item.full))
		.filter(Boolean)
		.join(" · ");
}

function compose(items: FooterItem[], width: number): string {
	const active = [...items];
	const compactIds = new Set<FooterItemId>();
	const measured = () => visibleWidth(renderItems(active, compactIds));
	const optional = active.filter((item) => !item.required).sort((a, b) => a.dropRank - b.dropRank);
	// Compact every optional category before removing any category. This keeps the
	// one-line overview broad even when the editor redraws at modest widths.
	for (const item of optional) {
		if (measured() <= width) break;
		if (item.full !== item.compact) compactIds.add(item.id);
	}
	for (const item of optional) {
		if (measured() <= width) break;
		const index = active.findIndex((candidate) => candidate.id === item.id);
		if (index >= 0) active.splice(index, 1);
	}
	for (const item of active.filter((candidate) => candidate.required)) {
		if (measured() <= width) break;
		if (item.full !== item.compact) compactIds.add(item.id);
	}
	return truncateToWidth(renderItems(active, compactIds), width, "");
}

export function renderFooterLine(
	state: FooterState,
	theme: ThemeLike,
	width: number,
	colorEnabled = true,
	_workingDots = "...",
): string {
	if (width <= 0) return "";
	const line = compose(buildItems(state, theme, colorEnabled), width);
	return truncateToWidth(line, width, "");
}

export interface FooterComponentOptions {
	getState(): FooterState;
	isSidebarPresented?(): boolean;
	colorEnabled?: boolean;
	requestRender(): void;
	onBranchChange(callback: () => void): () => void;
	theme: ThemeLike;
}

export function createFooterComponent(options: FooterComponentOptions): Component & { dispose(): void } {
	let disposed = false;
	const unsubscribe = options.onBranchChange(options.requestRender);

	return {
		render(width) {
			const state = options.getState();
			const colorEnabled = options.colorEnabled ?? true;
			return [renderFooterLine(state, options.theme, width, colorEnabled)];
		},
		invalidate() {},
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
		},
	};
}
