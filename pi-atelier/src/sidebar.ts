import { homedir } from "node:os";
import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type OverlayHandle, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeLike } from "./footer.js";
import { aggregateMetrics, formatTokens } from "./metrics.js";
import { type AtelierPalette, createPalette, type PaletteRole } from "./palette.js";
import {
	EMPTY_RUN_ACTIVITY,
	formatDuration,
	formatResponsePerformance,
	type RunActivitySnapshot,
	type ToolActivity,
} from "./run-activity.js";
import {
	SIDEBAR_PANEL_MAX_ROW_CHARS,
	SIDEBAR_PANEL_MAX_ROWS,
	SIDEBAR_PANEL_MAX_TITLE_CHARS,
	type SidebarPanelData,
	type SidebarPanelRole,
	sanitizeSidebarPanelText,
} from "./sidebar-panels.js";
import { createSplitPaneController, type SplitPaneController } from "./split-pane.js";
import {
	CONTEXT_DANGER_PERCENT,
	CONTEXT_WARNING_PERCENT,
	CURRENCY_DECIMALS,
	type AtelierState,
	type WorkspacePulseState,
} from "./types.js";
import type { WorkspacePulseData } from "./workspace-pulse.js";

export interface SidebarSnapshotInput {
	state: AtelierState;
	cwd: string;
	sessionName?: string;
	sessionFile?: string;
	branchEntryCount: number;
	extensionStatuses: readonly string[];
	runActivity?: RunActivitySnapshot;
	sidebarPanels?: readonly SidebarPanelData[];
}

export interface SidebarSnapshot extends AtelierState {
	projectName: string;
	cwd: string;
	sessionName?: string;
	sessionFile?: string;
	persisted: boolean;
	branchEntryCount: number;
	runActivity: RunActivitySnapshot;
	sidebarPanels?: readonly SidebarPanelData[];
}

function workspacePulseData(pulse: WorkspacePulseState): WorkspacePulseData | undefined {
	return "data" in pulse ? pulse.data : undefined;
}

export function buildSidebarSnapshot(input: SidebarSnapshotInput): SidebarSnapshot {
	const pulseData = workspacePulseData(input.state.workspacePulse);
	const projectName = basename(pulseData?.root ?? input.cwd) || pulseData?.root || input.cwd;
	return {
		...input.state,
		projectName,
		cwd: input.cwd,
		...(input.sessionName ? { sessionName: input.sessionName } : {}),
		...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
		persisted: Boolean(input.sessionFile),
		branchEntryCount: input.branchEntryCount,
		extensionStatuses: input.extensionStatuses,
		runActivity: input.runActivity ?? EMPTY_RUN_ACTIVITY,
		sidebarPanels: input.sidebarPanels ?? [],
	};
}

const sanitize = (text: string): string =>
	text
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const display = (value: string | undefined): string => {
	const safe = value === undefined ? "" : sanitize(value);
	return safe || "—";
};

const finiteCount = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

function shortPath(path: string): string {
	const safe = sanitize(path);
	const home = homedir();
	if (safe === home) return "~";
	if (home && safe.startsWith(`${home}/`)) return `~${safe.slice(home.length)}`;
	return safe || "—";
}

function padToWidth(text: string, width: number): string {
	const safeWidth = Math.max(0, Math.trunc(width));
	const content = truncateToWidth(text, safeWidth, "");
	return `${content}${" ".repeat(Math.max(0, safeWidth - visibleWidth(content)))}`;
}

function renderDock(rows: string[], width: number, height: number, palette: AtelierPalette): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const contentWidth = Math.max(0, safeWidth - 2);
	const divider = palette.paint("dim", "│");
	return Array.from({ length: Math.max(safeHeight, rows.length) }, (_, index) => {
		const content = truncateToWidth(rows[index] ?? "", contentWidth, "");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
		return truncateToWidth(`${divider} ${content}${padding}`, safeWidth, "");
	});
}

function panelRows(
	title: string,
	rows: readonly string[],
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
	role: PaletteRole,
	jewel: "✦" | "✧",
): string[] {
	const safeWidth = Math.max(4, Math.trunc(width));
	const innerWidth = Math.max(0, safeWidth - 4);
	const safeTitle = sanitizeSidebarPanelText(title, SIDEBAR_PANEL_MAX_TITLE_CHARS).toUpperCase();
	const crownPrefix = `╭─ ${jewel} `;
	const crownFill = "─".repeat(
		Math.max(0, safeWidth - visibleWidth(crownPrefix) - visibleWidth(safeTitle) - 2),
	);
	const top = `${palette.paint(role, crownPrefix)}${theme.bold(
		palette.paint(role, safeTitle),
	)} ${palette.paint(role, `${crownFill}╮`)}`;
	const body = rows.map((row) => {
		const content = padToWidth(row, innerWidth);
		return `${palette.paint(role, "│")} ${content} ${palette.paint(role, "│")}`;
	});
	return [top, ...body, palette.paint(role, `╰${"─".repeat(safeWidth - 2)}╯`), ""];
}

function valueRow(value: string | undefined, palette: AtelierPalette, role: PaletteRole): string {
	const text = display(value);
	return palette.paint(text === "—" ? "dim" : role, text);
}

const COMPACT_SIDEBAR_MAX_WIDTH = 39;

interface SidebarLayout {
	compact: boolean;
	showToolNames: boolean;
}

function sidebarLayout(width: number): SidebarLayout {
	return { compact: width <= COMPACT_SIDEBAR_MAX_WIDTH, showToolNames: false };
}

function activityRole(activity: SidebarSnapshot["activity"]): PaletteRole {
	return activity === "working" ? "working" : "ready";
}

function activitySymbol(activity: SidebarSnapshot["activity"]): string {
	return activity === "working" ? "◆" : "●";
}

function agentRows(
	snapshot: SidebarSnapshot,
	layout: SidebarLayout,
	contentWidth: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): string[] {
	const activity = `${snapshot.activity.slice(0, 1).toUpperCase()}${snapshot.activity.slice(1)}`;
	const workingLabel =
		snapshot.activity === "working" && snapshot.workingLabel
			? sanitize(snapshot.workingLabel).toLowerCase()
			: "";
	const activityText = workingLabel ? `${activity} · ${workingLabel}` : activity;
	const status = theme.bold(
		palette.paint(
			activityRole(snapshot.activity),
			`${activitySymbol(snapshot.activity)} ${activityText || "—"}`,
		),
	);
	const model = valueRow(snapshot.modelId, palette, "primary");
	const provider = snapshot.provider ? palette.paint("muted", display(snapshot.provider).toUpperCase()) : "";
	const thinking = snapshot.thinkingLevel
		? palette.paint("primary", display(snapshot.thinkingLevel).toUpperCase())
		: "";
	const access =
		snapshot.modelId || snapshot.provider
			? palette.paint(
					snapshot.metrics.subscription ? "ready" : "muted",
					snapshot.metrics.subscription ? "SUBSCRIPTION" : "METERED",
				)
			: "";
	const separator = ` ${palette.paint("dim", "·")} `;

	if (layout.compact) {
		const rows = [status, model];
		if (provider) rows.push(provider);
		const secondary = [thinking, access].filter(Boolean);
		if (secondary.length > 0) rows.push(secondary.join(separator));
		return rows;
	}

	const metadata = [provider, thinking, access].filter(Boolean);
	return [
		spacedRow(status, model, contentWidth),
		metadata.length > 0 ? metadata.join(separator) : palette.paint("dim", "—"),
	];
}

function pulseIndicator(pulse: WorkspacePulseState): { symbol: string; role: PaletteRole } {
	if (pulse.status === "conflict") return { symbol: "✕", role: "error" };
	if (pulse.status === "changed") return { symbol: "▲", role: "warning" };
	if (pulse.status === "stale") return { symbol: "~", role: "warning" };
	if (pulse.status === "clean") return { symbol: "", role: "ready" };
	return { symbol: "", role: "dim" };
}

function formatPulseCount(value: number): string {
	const count = finiteCount(value);
	if (count < 1_000) return count.toString();
	if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

interface WorkspacePulseRows {
	core: string[];
	details: string[];
}

function workspacePulseRows(
	pulse: WorkspacePulseState,
	layout: SidebarLayout,
	palette: AtelierPalette,
): WorkspacePulseRows {
	if (pulse.status === "inspecting") return { core: [palette.paint("muted", "inspecting…")], details: [] };
	if (pulse.status === "not-repo")
		return { core: [palette.paint("dim", "not a Git repository")], details: [] };
	if (pulse.status === "unavailable")
		return { core: [palette.paint("warning", "Git unavailable")], details: [] };
	if (!("data" in pulse)) return { core: [], details: [] };

	const { snapshot } = pulse.data;
	if (pulse.status === "clean") return { core: [palette.paint("ready", "✓ clean")], details: [] };
	const tracked = `${formatPulseCount(snapshot.trackedFiles)} tracked`;
	const lines = `+${formatPulseCount(snapshot.linesAdded)}  −${formatPulseCount(snapshot.linesRemoved)}`;
	const role = pulse.status === "stale" ? "warning" : "primary";
	const prefix = pulse.status === "stale" ? "~ stale · " : "";
	const core = layout.compact
		? [palette.paint(role, `${prefix}${tracked}`), palette.paint(role, lines)]
		: [palette.paint(role, `${prefix}${tracked}  ${lines}`)];
	if (snapshot.conflicts > 0)
		core.push(palette.paint("error", `${finiteCount(snapshot.conflicts)} conflicts`));
	const details = [
		snapshot.untrackedFiles > 0
			? layout.compact
				? `?${formatPulseCount(snapshot.untrackedFiles)}`
				: `${formatPulseCount(snapshot.untrackedFiles)} untracked`
			: "",
		snapshot.binaryFiles > 0
			? layout.compact
				? `bin${formatPulseCount(snapshot.binaryFiles)}`
				: `${formatPulseCount(snapshot.binaryFiles)} binary`
			: "",
		snapshot.submodules > 0
			? layout.compact
				? `sub${formatPulseCount(snapshot.submodules)}`
				: `${formatPulseCount(snapshot.submodules)} submodule`
			: "",
	].filter(Boolean);
	return { core, details: details.length > 0 ? [palette.paint("muted", details.join(" · "))] : [] };
}

interface WorkspaceRows {
	identity: string[];
	location: string[];
	pulseCore: string[];
	pulseDetails: string[];
	session: string[];
}

function workspaceRows(
	snapshot: SidebarSnapshot,
	layout: SidebarLayout,
	palette: AtelierPalette,
): WorkspaceRows {
	const project = valueRow(snapshot.projectName, palette, "primary");
	const branch = snapshot.branch ? palette.paint("accent", display(snapshot.branch)) : "";
	const indicator = pulseIndicator(snapshot.workspacePulse);
	const gitState = branch && indicator.symbol ? palette.paint(indicator.role, indicator.symbol) : "";
	const identity = branch ? `${project} ${palette.paint("dim", "·")} ${branch} ${gitState}` : project;
	const identityRows = layout.compact ? [project, ...(branch ? [`${branch} ${gitState}`] : [])] : [identity];
	const pulseData = workspacePulseData(snapshot.workspacePulse);
	const location = pulseData?.relativeCwd
		? [palette.paint("muted", `./${sanitize(pulseData.relativeCwd)}`)]
		: pulseData
			? []
			: [palette.paint("muted", shortPath(snapshot.cwd))];
	const pulse = workspacePulseRows(snapshot.workspacePulse, layout, palette);
	const sessionName = snapshot.sessionName ? sanitize(snapshot.sessionName) : "";
	const session = [
		...(sessionName ? [palette.paint("primary", sessionName)] : []),
		`${palette.paint("primary", `${finiteCount(snapshot.branchEntryCount)} entries`)} ${palette.paint(
			"dim",
			"·",
		)} ${palette.paint(snapshot.persisted ? "ready" : "muted", snapshot.persisted ? "persisted" : "ephemeral")}`,
	];
	return {
		identity: identityRows,
		location,
		pulseCore: pulse.core,
		pulseDetails: pulse.details,
		session,
	};
}

function contextRole(snapshot: SidebarSnapshot): PaletteRole {
	const percent = snapshot.metrics.contextPercent;
	if (percent === null || !Number.isFinite(percent)) return "dim";
	if (percent >= CONTEXT_DANGER_PERCENT) return "error";
	if (percent >= CONTEXT_WARNING_PERCENT) return "warning";
	return "context";
}

function spacedRow(left: string, right: string, width: number): string {
	const safeWidth = Math.max(0, Math.trunc(width));
	const rightWidth = visibleWidth(right);
	const leftMax = Math.max(0, safeWidth - rightWidth - 1);
	const safeLeft = truncateToWidth(left, leftMax, "");
	const gap = " ".repeat(Math.max(1, safeWidth - visibleWidth(safeLeft) - rightWidth));
	return truncateToWidth(`${safeLeft}${gap}${right}`, safeWidth, "");
}

function contextRows(
	snapshot: SidebarSnapshot,
	contentWidth: number,
	layout: SidebarLayout,
	palette: AtelierPalette,
): string[] {
	const { metrics } = snapshot;
	const available =
		metrics.contextTokens !== null &&
		Number.isFinite(metrics.contextTokens) &&
		metrics.contextPercent !== null &&
		Number.isFinite(metrics.contextPercent);
	if (!available) {
		return [palette.paint("dim", "Context unavailable")];
	}

	const role = contextRole(snapshot);
	const usage = `${formatTokens(metrics.contextTokens ?? 0)} / ${
		metrics.contextWindow > 0 ? formatTokens(metrics.contextWindow) : "—"
	}`;
	const percent = `${metrics.contextPercent?.toFixed(1)}%`;
	const meterWidth = layout.compact
		? Math.max(1, Math.min(10, contentWidth - 2))
		: Math.max(1, Math.min(10, contentWidth - visibleWidth(usage) - visibleWidth(percent) - 4));
	const filled = Math.min(
		meterWidth,
		Math.max(0, Math.round(((metrics.contextPercent ?? 0) / 100) * meterWidth)),
	);
	const meter = `${palette.paint("dim", "[")}${palette.paint(role, "■".repeat(filled))}${palette.paint(
		"dim",
		"·".repeat(Math.max(0, meterWidth - filled)),
	)}${palette.paint("dim", "]")}`;
	return [spacedRow(palette.paint(role, usage), palette.paint(role, percent), contentWidth), meter];
}

const currencyDecimals = (value: number): number =>
	Number.isFinite(value) ? Math.min(6, Math.max(0, Math.trunc(value))) : 0;

function formatUsageTokens(count: number): string {
	const safe = Number.isFinite(count) ? Math.max(0, count) : 0;
	if (safe < 1_000) return Math.trunc(safe).toString();
	if (safe < 1_000_000) return `${(safe / 1_000).toFixed(1)}k`;
	if (safe < 1_000_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
	return `${(safe / 1_000_000_000).toFixed(1)}B`;
}

function metricValue(label: string, value: string, palette: AtelierPalette, role: PaletteRole): string {
	return `${palette.paint("muted", label)} ${palette.paint(role, value)}`;
}

function metricPairRows(
	left: string,
	right: string,
	contentWidth: number,
	layout: SidebarLayout,
	palette: AtelierPalette,
): string[] {
	const separator = layout.compact ? ` ${palette.paint("dim", "·")} ` : "  ";
	const inline = `${left}${separator}${right}`;
	return visibleWidth(inline) <= contentWidth ? [inline] : [left, right];
}

function usageRows(
	snapshot: SidebarSnapshot,
	contentWidth: number,
	layout: SidebarLayout,
	palette: AtelierPalette,
): string[] {
	const { metrics } = snapshot;
	if (!metrics.usageAvailable && !metrics.costAvailable) return [];

	const rows: string[] = [];
	if (metrics.usageAvailable) {
		rows.push(
			...metricPairRows(
				metricValue("In", formatUsageTokens(metrics.input), palette, "input"),
				metricValue("Out", formatUsageTokens(metrics.output), palette, "output"),
				contentWidth,
				layout,
				palette,
			),
		);
		const hit =
			metrics.cacheHitPercent !== undefined && Number.isFinite(metrics.cacheHitPercent)
				? `${metrics.cacheHitPercent.toFixed(1)}%`
				: "—";
		rows.push(
			...metricPairRows(
				metricValue("Cache", formatUsageTokens(metrics.cacheRead), palette, "cache"),
				layout.compact
					? palette.paint(hit === "—" ? "dim" : "cache", hit)
					: metricValue("Hit", hit, palette, hit === "—" ? "dim" : "cache"),
				contentWidth,
				layout,
				palette,
			),
		);
	}
	if (metrics.costAvailable) {
		const cost = `$${Math.max(0, Number.isFinite(metrics.cost) ? metrics.cost : 0).toFixed(
			currencyDecimals(CURRENCY_DECIMALS),
		)}`;
		rows.push(metricValue("Cost", cost, palette, "cost"));
	}
	return rows;
}

const exceptionStatusPattern =
	/\b(error|failed?|failure|warn(?:ing)?|offline|unavailable|blocked|degraded)\b/i;

function statusDetailPanelRole(snapshot: SidebarSnapshot): PaletteRole {
	return snapshot.extensionStatuses.some((status) =>
		/\b(error|failed?|failure|offline|unavailable)\b/i.test(sanitize(status)),
	)
		? "error"
		: "warning";
}

function statusDetailRows(snapshot: SidebarSnapshot, palette: AtelierPalette): string[] {
	const statuses = snapshot.extensionStatuses
		.map(sanitize)
		.filter((status) => status && exceptionStatusPattern.test(status));
	if (statuses.length === 0) return [];
	return [
		...statuses.map((status) => {
			const role: PaletteRole = /\b(error|failed?|failure|offline|unavailable)\b/i.test(status)
				? "error"
				: "warning";
			return palette.paint(role, `${role === "error" ? "✕" : "▲"} ${status}`);
		}),
	];
}

interface ActivityGroups {
	core: string[];
	active: Array<{ id: string; row: string }>;
	recent: Array<{ id: string; row: string }>;
	aggregate: string[];
}

interface SidebarGroup {
	name: string;
	panel?: string;
	panelId?: string;
	panelRole?: PaletteRole;
	panelJewel?: "✦" | "✧";
	rows: string[];
}

function renderGroups(
	groups: readonly SidebarGroup[],
	width: number,
	palette: AtelierPalette,
	theme: ThemeLike,
): string[] {
	const rendered: string[] = [];
	for (let index = 0; index < groups.length; ) {
		const group = groups[index];
		if (!group) break;
		if (!group.panel) {
			rendered.push(...group.rows);
			index += 1;
			continue;
		}

		const rows: string[] = [];
		let next = index;
		while (groups[next]?.panel === group.panel && groups[next]?.panelId === group.panelId) {
			rows.push(...(groups[next]?.rows ?? []));
			next += 1;
		}
		if (rows.length > 0) {
			rendered.push(
				...panelRows(
					group.panel,
					rows,
					width,
					palette,
					theme,
					group.panelRole ?? "accent",
					group.panelJewel ?? "✦",
				),
			);
		}
		index = next;
	}
	return rendered;
}

function panelIdForTitle(title: string): string | undefined {
	return {
		AGENT: "agent",
		ACTIVITY: "activity",
		ALERTS: "alerts",
		CONTEXT: "context",
		WORKSPACE: "workspace",
		USAGE: "usage",
	}[title];
}

function contributedRows(panel: SidebarPanelData, palette: AtelierPalette): string[] {
	const rows = panel.rows.slice(0, SIDEBAR_PANEL_MAX_ROWS).map((row) => {
		const text = sanitizeSidebarPanelText(
			typeof row === "string" ? row : row.text,
			SIDEBAR_PANEL_MAX_ROW_CHARS,
		);
		const role = typeof row === "string" ? panel.role : (row.role ?? panel.role);
		return palette.paint((role ?? "primary") as SidebarPanelRole, text);
	});
	return rows.filter((row) => visibleWidth(row) > 0);
}

function durationForTool(tool: ToolActivity, now: number): string {
	return formatDuration(tool.durationMs ?? Math.max(0, now - tool.startedAt));
}

function toolStatusRole(status: ToolActivity["status"]): PaletteRole {
	if (status === "failed") return "error";
	if (status === "running") return "working";
	return "ready";
}

function toolStatusLabel(tool: ToolActivity, now: number): string {
	const duration = durationForTool(tool, now);
	if (tool.status === "running") return duration;
	return `${tool.status} ${duration}`;
}

function toolActivityRow(
	tool: ToolActivity,
	contentWidth: number,
	palette: AtelierPalette,
	now: number,
): string {
	const safeName = sanitize(tool.name) || "tool";
	const safeSummary = sanitize(tool.summary);
	const status = toolStatusLabel(tool, now);
	const statusWidth = visibleWidth(status);
	const nameWidth = Math.min(Math.max(visibleWidth(safeName), 4), 10, Math.max(0, contentWidth));
	const summaryWidth = Math.max(0, contentWidth - nameWidth - statusWidth - 2);
	const statusText = truncateToWidth(status, Math.max(0, contentWidth - nameWidth - summaryWidth - 2), "");
	const row = `${padToWidth(palette.paint("muted", safeName), nameWidth)} ${padToWidth(
		palette.paint(safeSummary ? "primary" : "dim", safeSummary || "—"),
		summaryWidth,
	)} ${palette.paint(toolStatusRole(tool.status), statusText)}`;
	return truncateToWidth(row, contentWidth, "");
}

function runSummaryRow(activity: RunActivitySnapshot, palette: AtelierPalette, now: number): string {
	if (activity.phase === "idle") return palette.paint("ready", "Ready");
	const duration =
		activity.phase === "settled"
			? formatDuration(activity.durationMs ?? Math.max(0, now - (activity.startedAt ?? now)))
			: formatDuration(Math.max(0, now - (activity.startedAt ?? now)));
	const role: PaletteRole =
		activity.phase === "running" ? "working" : activity.failedCount > 0 ? "error" : "ready";
	if (activity.phase === "settled") return palette.paint(role, `Last run · ${duration}`);

	const label = activity.turnNumber === undefined ? "Run" : `Turn ${finiteCount(activity.turnNumber)}`;
	return palette.paint(role, `${label} · ${activity.phase} ${duration}`);
}

function responsePerformanceRow(activity: RunActivitySnapshot, palette: AtelierPalette): string {
	return palette.paint("output", formatResponsePerformance(activity.performance));
}

function activityRows(
	activity: RunActivitySnapshot,
	contentWidth: number,
	palette: AtelierPalette,
	now: number,
): ActivityGroups {
	const activeIds = new Set(activity.activeTools.map((tool) => tool.id));
	const active = activity.activeTools
		.map((tool, index) => ({ index, tool }))
		.sort((left, right) => left.tool.startedAt - right.tool.startedAt || left.index - right.index)
		.map(({ tool }) => ({ id: tool.id, row: toolActivityRow(tool, contentWidth, palette, now) }));
	const recent = activity.recentTools
		.filter((tool) => !activeIds.has(tool.id))
		.slice(0, 3)
		.map((tool) => ({ id: tool.id, row: toolActivityRow(tool, contentWidth, palette, now) }));
	const aggregateText = aggregateActivityText(activity);
	return {
		core: [runSummaryRow(activity, palette, now), responsePerformanceRow(activity, palette)],
		active,
		recent,
		aggregate: aggregateText
			? [palette.paint(activity.failedCount > 0 ? "error" : "ready", aggregateText)]
			: [],
	};
}

function aggregateActivityText(activity: RunActivitySnapshot): string {
	const completed = finiteCount(activity.completedCount);
	const failed = finiteCount(activity.failedCount);
	if (completed === 0 && failed === 0) return "";
	return `tools ${completed} done · ${failed} failed`;
}

function activitySidebarGroups(
	snapshot: SidebarSnapshot,
	contentWidth: number,
	palette: AtelierPalette,
	now: number,
): SidebarGroup[] {
	const groups = activityRows(snapshot.runActivity, contentWidth, palette, now);
	const panelRole: PaletteRole =
		snapshot.runActivity.phase === "running"
			? "working"
			: snapshot.runActivity.failedCount > 0
				? "error"
				: "ready";
	return [
		{
			name: "activityCore",
			panel: "ACTIVITY",
			panelRole,
			rows: groups.core,
		},
		...groups.active.map((active, index, rows) => ({
			name: `activityActive:${active.id}`,
			panel: "ACTIVITY",
			panelRole,
			rows: [active.row],
		})),
		...groups.recent.map((recent, index) => ({
			name: `activityRecent:${recent.id}`,
			panel: "ACTIVITY",
			panelRole,
			rows: [recent.row],
		})),
		{
			name: "activityAggregate",
			panel: "ACTIVITY",
			panelRole,
			rows: groups.aggregate,
		},
	].filter((group) => group.rows.length > 0);
}

export function renderSidebarLines(
	snapshot: SidebarSnapshot,
	theme: ThemeLike,
	width: number,
	height: number,
	colorEnabled = true,
	now = Date.now(),
): string[] {
	const palette = createPalette(theme, colorEnabled);
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const contentWidth = Math.max(0, safeWidth - 2);
	const panelContentWidth = Math.max(0, contentWidth - 4);
	const layout = sidebarLayout(safeWidth);
	const workspace = workspaceRows(snapshot, layout, palette);
	const groups: SidebarGroup[] = [
		{
			name: "agent",
			panel: "AGENT",
			panelRole: activityRole(snapshot.activity),
			panelJewel:
				snapshot.activity === "working" && Math.floor(now / 400) % 2 === 1 ? ("✧" as const) : ("✦" as const),
			rows: agentRows(snapshot, layout, panelContentWidth, palette, theme),
		},
		...activitySidebarGroups(snapshot, panelContentWidth, palette, now).map((group) => ({
			...group,
		})),
		{
			name: "statusDetails",
			panel: "ALERTS",
			panelRole: statusDetailPanelRole(snapshot),
			rows: statusDetailRows(snapshot, palette),
		},
		{
			name: "context",
			panel: "CONTEXT",
			panelRole: contextRole(snapshot),
			rows: contextRows(snapshot, panelContentWidth, layout, palette),
		},
		{
			name: "workspaceCore",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.identity,
		},
		{
			name: "workspaceLocation",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.location,
		},
		{
			name: "workspaceCore",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.pulseCore,
		},
		{
			name: "workspaceDetails",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.pulseDetails,
		},
		{
			name: "workspaceSession",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.session,
		},
		{
			name: "usage",
			panel: "USAGE",
			panelRole: "output",
			rows: usageRows(snapshot, panelContentWidth, layout, palette),
		},
	];

	// Compose the fixed local layout. External contributed panels remain
	// supported after the built-in sequence; there is no interactive layout editor.
	const contributed = new Map((snapshot.sidebarPanels ?? []).map((panel) => [panel.id, panel]));
	const grouped = new Map<string, SidebarGroup[]>();
	for (const group of groups) {
		const id = group.panel ? panelIdForTitle(group.panel) : undefined;
		if (!id) continue;
		group.panelId = id;
		const list = grouped.get(id) ?? [];
		list.push(group);
		grouped.set(id, list);
	}
	const ordered: SidebarGroup[] = groups.filter((group) => !group.panel);
	for (const id of [
		"plannotator:progress",
		"agent",
		"activity",
		"alerts",
		"context",
		"workspace",
		"usage",
	] as const) {
		const panel = id === "plannotator:progress" ? contributed.get(id) : undefined;
		if (panel) {
			const rows = contributedRows(panel, palette);
			ordered.push({
				name: `contributed:${panel.id}`,
				panel: sanitize(panel.title).toUpperCase() || panel.id,
				panelId: panel.id,
				panelRole: panel.role ?? "accent",
				rows: rows.length > 0 ? rows : [palette.paint("dim", "No data")],
			});
		} else {
			ordered.push(...(grouped.get(id) ?? []));
		}
	}
	for (const panel of contributed.values()) {
		if (panel.id === "plannotator:progress") continue;
		const rows = contributedRows(panel, palette);
		ordered.push({
			name: `contributed:${panel.id}`,
			panel: sanitize(panel.title).toUpperCase() || panel.id,
			panelId: panel.id,
			panelRole: panel.role ?? "accent",
			rows: rows.length > 0 ? rows : [palette.paint("dim", "No data")],
		});
	}
	return renderDock(renderGroups(ordered, contentWidth, palette, theme), safeWidth, safeHeight, palette);
}

export interface SidebarComponentOptions {
	getSnapshot(): SidebarSnapshot;
	getHeight(): number;
	theme: ThemeLike;
	colorEnabled?: boolean;
}

function renderSidebarError(error: unknown, width: number, height: number): string[] {
	let detail = "Unknown error";
	try {
		detail = sanitize(error instanceof Error ? error.message : String(error)) || detail;
	} catch {
		// Keep the fallback render path safe even for unusual thrown values.
	}
	return renderDock(["Sidebar unavailable", detail], width, height, {
		paint: (_role, text) => text,
	});
}

export function createSidebarComponent(options: SidebarComponentOptions): Component {
	return {
		render(width) {
			const height = options.getHeight();
			try {
				return renderSidebarLines(
					options.getSnapshot(),
					options.theme,
					width,
					height,
					options.colorEnabled ?? true,
				);
			} catch (error) {
				return renderSidebarError(error, width, height);
			}
		},
		invalidate() {},
	};
}

export interface SidebarController {
	show(): void;
	hide(): void;
	toggle(): void;
	isVisible(): boolean;
	isPresented(): boolean;
	requestRender(): void;
	dispose(): void;
}

export interface SidebarControllerOptions {
	ctx: ExtensionContext;
	getSnapshot(): SidebarSnapshot;
	colorEnabled?: boolean;
	shouldAnimate?(): boolean;
	animationIntervalMs?: number;
	onError?(error: unknown): void;
	onPresentationChange?(): void;
}

interface RetirableSidebarBinding {
	getSnapshot(): SidebarSnapshot;
	detach(): void;
}

function createDetachedSidebarSnapshot(cwd: string): SidebarSnapshot {
	return buildSidebarSnapshot({
		state: {
			activity: "ready",
			dirty: false,
			workspacePulse: { status: "unavailable" },
			metrics: aggregateMetrics([], { subscription: false, autoCompact: null }),
			extensionStatuses: [],
		},
		cwd,
		branchEntryCount: 0,
		extensionStatuses: [],
		sidebarPanels: [],
	});
}

function cloneSidebarSnapshot(snapshot: SidebarSnapshot): SidebarSnapshot {
	return structuredClone(snapshot);
}

function createRetirableSidebarBinding(options: SidebarControllerOptions): RetirableSidebarBinding {
	let readSnapshot: (() => SidebarSnapshot) | undefined = options.getSnapshot;
	let snapshot = createDetachedSidebarSnapshot(typeof options.ctx.cwd === "string" ? options.ctx.cwd : "");
	return {
		getSnapshot: () => (readSnapshot ? readSnapshot() : snapshot),
		detach: () => {
			if (readSnapshot) {
				try {
					snapshot = cloneSidebarSnapshot(readSnapshot());
				} catch {
					// The inert snapshot is already detached from the retired runtime.
				}
			}
			readSnapshot = undefined;
		},
	};
}

export function createSidebarController(options: SidebarControllerOptions): SidebarController {
	const binding = createRetirableSidebarBinding(options);
	let enabled = false;
	let disposed = false;
	let generation = 0;
	let closeOverlay: (() => void) | undefined;
	let requestOverlayRender: (() => void) | undefined;
	let splitRequestRender: (() => void) | undefined;
	let overlayHandle: OverlayHandle | undefined;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	const animationIntervalMs = Math.max(1, Math.trunc(options.animationIntervalMs ?? 1_000));

	const reportError = (error: unknown) => {
		try {
			options.onError?.(error);
		} catch {
			// External error reporting must not interrupt lifecycle cleanup.
		}
	};

	const safely = (action: () => unknown): boolean => {
		try {
			action();
			return true;
		} catch (error) {
			reportError(error);
			return false;
		}
	};

	const split: SplitPaneController = createSplitPaneController({
		onPresentationChange: () => {
			safely(() => requestOverlayRender?.());
			safely(() => splitRequestRender?.());
			try {
				options.onPresentationChange?.();
			} catch {
				// Presentation invalidation is best effort.
			}
		},
	});

	const stopAnimation = () => {
		if (!animationTimer) return;
		clearInterval(animationTimer);
		animationTimer = undefined;
	};

	const syncAnimation = () => {
		if (!enabled || options.shouldAnimate?.() !== true || !requestOverlayRender) {
			stopAnimation();
			return;
		}
		if (animationTimer) return;
		animationTimer = setInterval(() => {
			safely(() => requestOverlayRender?.());
		}, animationIntervalMs);
		animationTimer.unref?.();
	};

	const clearOverlayCallbacks = () => {
		closeOverlay = undefined;
		requestOverlayRender = undefined;
		splitRequestRender = undefined;
		overlayHandle = undefined;
	};

	const hide = () => {
		if (!enabled && !closeOverlay && !overlayHandle && !split.isEnabled()) return;
		enabled = false;
		generation += 1;
		stopAnimation();
		const close = closeOverlay;
		const handle = overlayHandle;
		clearOverlayCallbacks();
		if (close) safely(close);
		else if (handle) safely(() => handle.hide());
		safely(split.hide);
	};

	const show = () => {
		if (disposed || enabled) return;
		if (options.ctx.mode !== "tui") {
			reportError(new Error("Pi Atelier sidebar requires TUI mode"));
			return;
		}

		enabled = true;
		const currentGeneration = ++generation;
		if (!safely(split.show)) {
			enabled = false;
			stopAnimation();
			clearOverlayCallbacks();
			safely(split.hide);
			return;
		}
		try {
			const pending = options.ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					let closed = false;
					const component = createSidebarComponent({
						getSnapshot: binding.getSnapshot,
						getHeight: () => tui.terminal.rows,
						theme: theme as unknown as ThemeLike,
						...(options.colorEnabled === undefined ? {} : { colorEnabled: options.colorEnabled }),
					});
					const close = () => {
						if (closed) return;
						closed = true;
						done(undefined);
					};
					if (!safely(() => split.attach(tui, component))) {
						enabled = false;
						generation += 1;
						stopAnimation();
						clearOverlayCallbacks();
						safely(split.hide);
						safely(close);
					} else {
						splitRequestRender = () => tui.requestRender();
						if (enabled && generation === currentGeneration) {
							closeOverlay = close;
							requestOverlayRender = () => tui.requestRender();
							syncAnimation();
						} else {
							close();
						}
					}
					return component;
				},
				{
					overlay: true,
					overlayOptions: () => split.overlayOptions(),
					onHandle: (handle) => {
						if (enabled && generation === currentGeneration) {
							overlayHandle = handle;
							syncAnimation();
						} else {
							safely(() => handle.hide());
						}
					},
				},
			);
			void pending
				.catch((error: unknown) => {
					reportError(error);
				})
				.finally(() => {
					if (generation !== currentGeneration) return;
					enabled = false;
					stopAnimation();
					clearOverlayCallbacks();
					safely(split.hide);
				});
		} catch (error) {
			if (generation === currentGeneration) {
				enabled = false;
				stopAnimation();
				clearOverlayCallbacks();
				safely(split.hide);
			}
			reportError(error);
		}
	};

	return {
		show,
		hide,
		toggle() {
			if (enabled) hide();
			else show();
		},
		isVisible() {
			return enabled;
		},
		isPresented: split.isPresented,
		requestRender() {
			safely(() => requestOverlayRender?.());
			safely(split.requestRender);
			syncAnimation();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			hide();
			binding.detach();
			safely(split.dispose);
		},
	};
}
