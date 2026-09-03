import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	HStack,
	type OverlayHandle,
	ScrollView,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ThemeLike } from "./footer.js";
import { aggregateMetrics } from "./metrics.js";
import { type AtelierPalette, createPalette, type PaletteRole } from "./palette.js";
import {
	EMPTY_RUN_ACTIVITY,
	formatDuration,
	formatResponsePerformance,
	type PermissionActivity,
	type RunActivitySnapshot,
	type ToolActivity,
} from "./run-activity.js";
import type { SidebarPanelData } from "./sidebar-panels.js";
import { createSplitPaneController, type SplitPaneController } from "./split-pane.js";
import { type AtelierState, type ProgressObserverSnapshot, type WorkspacePulseState } from "./types.js";
import type { WorkspacePulseData } from "./workspace-pulse.js";

export interface SidebarSnapshotInput {
	state: AtelierState;
	cwd: string;
	sessionName?: string;
	sessionFile?: string;
	branchEntryCount: number;
	extensionStatuses: readonly string[];
	runActivity?: RunActivitySnapshot;
	autoModeState?: {
		enabled: boolean;
		usable: boolean;
		modelId: string;
		allowed: number;
		asked: number;
	};
	sidebarPanels?: readonly SidebarPanelData[];
	progressObserver?: ProgressObserverSnapshot;
}

export interface SidebarSnapshot extends AtelierState {
	projectName: string;
	cwd: string;
	sessionName?: string;
	sessionFile?: string;
	persisted: boolean;
	branchEntryCount: number;
	runActivity: RunActivitySnapshot;
	autoModeState?: {
		enabled: boolean;
		usable: boolean;
		modelId: string;
		allowed: number;
		asked: number;
	};
	sidebarPanels?: readonly SidebarPanelData[];
	progressObserver?: ProgressObserverSnapshot;
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
		...(input.autoModeState ? { autoModeState: input.autoModeState } : {}),
		sidebarPanels: input.sidebarPanels ?? [],
		...(input.progressObserver ? { progressObserver: input.progressObserver } : {}),
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

function spacedRow(left: string, right: string, width: number): string {
	const safeWidth = Math.max(0, Math.trunc(width));
	const rightWidth = visibleWidth(right);
	const leftMax = Math.max(0, safeWidth - rightWidth - 1);
	const safeLeft = truncateToWidth(left, leftMax, "");
	const gap = " ".repeat(Math.max(1, safeWidth - visibleWidth(safeLeft) - rightWidth));
	return truncateToWidth(`${safeLeft}${gap}${right}`, safeWidth, "");
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

// Nerd Fonts v3 semantic glyphs. Keep whitespace outside each glyph: many
// terminal fonts use nearly the full cell and become hard to scan when joined.
const PERMISSION_SOURCE_ICON: Record<PermissionActivity["source"], string> = {
	policy: "󰒃", // nf-md-security
	security: "󰒃", // deterministic safety guard
	auto: "󰚩", // nf-md-robot
	human: "󰀄", // nf-md-account
	authorizer: "󰌆", // nf-md-key
	system: "󰀦", // nf-md-alert_circle
};

function permissionSourceRole(source: PermissionActivity["source"]): PaletteRole {
	if (source === "policy") return "permissionPolicy";
	if (source === "security") return "permissionSecurity";
	if (source === "auto") return "permissionAuto";
	if (source === "human") return "permissionHuman";
	return "muted";
}

function permissionStateRole(permission: PermissionActivity): PaletteRole {
	if (permission.state === "deny") return "error";
	if (permission.state === "unsure" || permission.state === "pending") return "warning";
	return permissionSourceRole(permission.source);
}

function permissionOutcome(permission: PermissionActivity): string {
	return permission.state === "allow" ? "✓" : permission.state === "deny" ? "✕" : "?";
}

function sourceOutcome(
	source: PermissionActivity["source"],
	outcome: string,
	outcomeRole: PaletteRole,
	palette: AtelierPalette,
): string {
	return `${palette.paint(permissionSourceRole(source), PERMISSION_SOURCE_ICON[source])} ${palette.paint(
		outcomeRole,
		outcome,
	)}`;
}

/** Render provenance as spaced semantic glyphs rather than letter abbreviations. */
function permissionBadge(permission: PermissionActivity, palette: AtelierPalette): string {
	const final = sourceOutcome(
		permission.source,
		permissionOutcome(permission),
		permissionStateRole(permission),
		palette,
	);
	if (permission.source !== "human") return final;
	const prior =
		permission.prior === "auto-unsure"
			? sourceOutcome("auto", "?", "warning", palette)
			: permission.prior === "security-review"
				? sourceOutcome("security", "?", "warning", palette)
				: permission.prior === "policy-ask"
					? sourceOutcome("policy", "?", "warning", palette)
					: "";
	return prior ? `${prior} ${palette.paint("dim", "→")} ${final}` : final;
}

const SUPERSCRIPT_DIGITS: Record<string, string> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
};

function superscriptCount(count: number): string {
	return String(count)
		.split("")
		.map((digit) => SUPERSCRIPT_DIGITS[digit] ?? digit)
		.join("");
}

interface PermissionBadgeGroup {
	permission: PermissionActivity;
	count: number;
}

/** Collapse only routine allows; exceptional checks stay individually visible. */
function groupPermissionBadges(permissions: readonly PermissionActivity[]): PermissionBadgeGroup[] {
	const groups: PermissionBadgeGroup[] = [];
	const routineAllowIndex = new Map<string, number>();
	for (const permission of permissions) {
		const routine = permission.state === "allow" && !permission.reason;
		const key = routine ? `${permission.source}:${permission.state}:${permission.prior ?? ""}` : "";
		const existingIndex = key ? routineAllowIndex.get(key) : undefined;
		if (existingIndex !== undefined) {
			const existing = groups[existingIndex];
			if (existing) groups[existingIndex] = { ...existing, count: existing.count + 1 };
			continue;
		}
		if (key) routineAllowIndex.set(key, groups.length);
		groups.push({ permission, count: 1 });
	}
	return groups;
}

function renderPermissionBadge(group: PermissionBadgeGroup, palette: AtelierPalette): string {
	const badge = permissionBadge(group.permission, palette);
	return group.count > 1 ? `${badge}${palette.paint("dim", superscriptCount(group.count))}` : badge;
}

function packBadgeRows(badges: readonly string[], width: number, prefix = "  "): string[] {
	if (width <= visibleWidth(prefix)) return [];
	const rows: string[] = [];
	let row = prefix;
	for (const badge of badges) {
		const separator = row === prefix ? "" : "  ";
		if (visibleWidth(row) + visibleWidth(separator) + visibleWidth(badge) <= width) {
			row += `${separator}${badge}`;
			continue;
		}
		if (row !== prefix) rows.push(row);
		row = `${prefix}${truncateToWidth(badge, Math.max(0, width - visibleWidth(prefix)), "")}`;
	}
	if (row !== prefix) rows.push(row);
	return rows;
}

function toolActivityRows(
	tool: ToolActivity,
	contentWidth: number,
	palette: AtelierPalette,
	now: number,
): string[] {
	const safeName = sanitize(tool.name) || "tool";
	const safeSummary = sanitize(tool.summary);
	const status = toolStatusLabel(tool, now);
	const statusWidth = Math.min(visibleWidth(status), Math.max(0, contentWidth));
	const nameWidth = Math.min(Math.max(visibleWidth(safeName), 4), 10, Math.max(0, contentWidth));
	const middleWidth = Math.max(0, contentWidth - nameWidth - statusWidth - 2);
	const groups = groupPermissionBadges(tool.permissions ?? []);
	const badges = groups.map((group) => renderPermissionBadge(group, palette));
	const minimumSummaryWidth = Math.min(visibleWidth(safeSummary || "—"), 6);
	const inline: string[] = [];
	let inlineWidth = 0;
	for (const badge of badges) {
		const nextWidth = inlineWidth + (inline.length > 0 ? 2 : 0) + visibleWidth(badge);
		if (nextWidth + 2 + minimumSummaryWidth > middleWidth) break;
		inline.push(badge);
		inlineWidth = nextWidth;
	}

	const inlineBadges = inline.join("  ");
	const summaryWidth = Math.max(0, middleWidth - (inline.length > 0 ? inlineWidth + 2 : 0));
	const summary = padToWidth(
		palette.paint(safeSummary ? "primary" : "dim", safeSummary || "—"),
		summaryWidth,
	);
	const middle = inline.length > 0 ? `${summary}  ${inlineBadges}` : summary;
	const statusText = truncateToWidth(status, statusWidth, "");
	const row = `${padToWidth(palette.paint("muted", safeName), nameWidth)} ${middle} ${palette.paint(
		toolStatusRole(tool.status),
		statusText,
	)}`;
	const overflowRows = packBadgeRows(badges.slice(inline.length), contentWidth);
	const reasonRows = (tool.permissions ?? [])
		.filter(
			(permission) =>
				permission.reason &&
				(permission.state === "deny" || permission.state === "unsure" || permission.source === "system"),
		)
		.map((permission) =>
			palette.paint("dim", truncateToWidth(`  ${sanitize(permission.reason ?? "")}`, contentWidth, "…")),
		);
	return [truncateToWidth(row, contentWidth, ""), ...overflowRows, ...reasonRows];
}

function standalonePermissionRows(
	permission: PermissionActivity,
	contentWidth: number,
	palette: AtelierPalette,
): string[] {
	const badge = permissionBadge(permission, palette);
	const surface = sanitize(permission.surface) || "permission";
	const subject = `${surface} ${sanitize(permission.value)}`.trim();
	const rows = [
		truncateToWidth(
			`${palette.paint("dim", "↳")} ${badge}  ${palette.paint("primary", subject)}`,
			contentWidth,
			"…",
		),
	];
	if (
		permission.reason &&
		(permission.state === "deny" || permission.state === "unsure" || permission.source === "system")
	) {
		rows.push(palette.paint("dim", truncateToWidth(`  ${sanitize(permission.reason)}`, contentWidth, "…")));
	}
	return rows;
}

function runSummaryRow(activity: RunActivitySnapshot, palette: AtelierPalette, now: number): string {
	if (activity.phase === "idle") return palette.paint("ready", "Ready");
	const duration =
		activity.phase === "settled"
			? formatDuration(activity.durationMs ?? Math.max(0, now - (activity.startedAt ?? now)))
			: formatDuration(Math.max(0, now - (activity.startedAt ?? now)));
	const role: PaletteRole = activity.failedCount > 0 ? "error" : "ready";
	return palette.paint(role, `Last run · ${duration}`);
}

const TURN_GLYPHS = {
	1: { outline: "󰲡", filled: "󰲠" }, // bottom-right from the Paddock
	2: { outline: "󰲣", filled: "󰲢" }, // top-right
	3: { outline: "󰲥", filled: "󰲤" }, // top-left
	4: { outline: "󰲧", filled: "󰲦" }, // bottom-left
} as const;

function centeredTrackContent(content: string, width: number, fill: string): string {
	const safeWidth = Math.max(0, Math.trunc(width));
	const safe = truncateToWidth(content, safeWidth, "");
	const remaining = Math.max(0, safeWidth - visibleWidth(safe));
	const left = Math.floor(remaining / 2);
	return `${fill.repeat(left)}${safe}${fill.repeat(remaining - left)}`;
}

function turnGlyph(
	corner: keyof typeof TURN_GLYPHS,
	activeTurn: number | undefined,
	palette: AtelierPalette,
	theme: ThemeLike,
): string {
	const active = activeTurn === corner;
	const glyph = active ? TURN_GLYPHS[corner].filled : TURN_GLYPHS[corner].outline;
	return active ? theme.bold(palette.paint("working", glyph)) : palette.paint("dim", glyph);
}

function turnTrackRows(
	activity: RunActivitySnapshot,
	palette: AtelierPalette,
	theme: ThemeLike,
	width: number,
	now: number,
): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	if (safeWidth < 8) return [runSummaryRow(activity, palette, now)];
	const absoluteTurn = activity.turnNumber === undefined ? undefined : finiteCount(activity.turnNumber);
	const activeTurn = absoluteTurn === undefined ? undefined : ((((absoluteTurn - 1) % 4) + 4) % 4) + 1;
	const turn = activeTurn as keyof typeof TURN_GLYPHS | undefined;
	const completed = finiteCount(activity.completedCount);
	const failed = finiteCount(activity.failedCount);
	const aggregate = `${palette.paint("ready", `${completed}✓`)} ${palette.paint("dim", "·")} ${palette.paint(
		"error",
		`${failed}✕`,
	)}`;
	const duration = formatDuration(Math.max(0, now - (activity.startedAt ?? now)));
	const total = absoluteTurn === undefined ? "RUN" : `T${absoluteTurn.toString().padStart(2, "0")}`;
	const middle = `${total} · ${duration}`;
	const edgeWidth = 10; // outer curve, spacing, and turn glyph on both sides
	const centerWidth = Math.max(0, safeWidth - edgeWidth);
	const topCenter = centeredTrackContent(` ${aggregate} `, centerWidth, "─");
	const middleCenter = centeredTrackContent(palette.paint("working", middle), safeWidth - 2, " ");
	return [
		`${palette.paint("dim", "╭─ ")}${turnGlyph(3, turn, palette, theme)} ${topCenter} ${turnGlyph(2, turn, palette, theme)}${palette.paint("dim", " ─╮")}`,
		`${palette.paint("dim", "│")}${middleCenter}${palette.paint("dim", "│")}`,
		// The bottom rail is completed by activityBandRows once auto counts are known.
	];
}

function turnTrackBottomRow(
	activity: RunActivitySnapshot,
	auto: SidebarSnapshot["autoModeState"],
	palette: AtelierPalette,
	theme: ThemeLike,
	width: number,
): string {
	const safeWidth = Math.max(0, Math.trunc(width));
	const absoluteTurn = activity.turnNumber === undefined ? undefined : finiteCount(activity.turnNumber);
	const activeTurn = absoluteTurn === undefined ? undefined : ((((absoluteTurn - 1) % 4) + 4) % 4) + 1;
	const turn = activeTurn as keyof typeof TURN_GLYPHS | undefined;
	const counts = auto
		? `${palette.paint("permissionAuto", `󰚩 ${finiteCount(auto.allowed)}`)} ${palette.paint("dim", "·")} ${palette.paint(
				"permissionHuman",
				`󰀄 ${finiteCount(auto.asked)}`,
			)}`
		: "";
	const centerWidth = Math.max(0, safeWidth - 10);
	const center = centeredTrackContent(counts ? ` ${counts} ` : "", centerWidth, "─");
	return `${palette.paint("dim", "╰─ ")}${turnGlyph(4, turn, palette, theme)} ${center} ${turnGlyph(1, turn, palette, theme)}${palette.paint("dim", " ─╯")}`;
}

function responsePerformanceRow(activity: RunActivitySnapshot, palette: AtelierPalette): string {
	return palette.paint("output", formatResponsePerformance(activity.performance));
}

function aggregateActivityText(activity: RunActivitySnapshot, compact: boolean): string {
	const completed = finiteCount(activity.completedCount);
	const failed = finiteCount(activity.failedCount);
	if (completed === 0 && failed === 0) return "";
	return compact ? `${completed}✓ ${failed}✕` : `${completed} done · ${failed} fail`;
}

function wrappedProgressValue(
	label: string,
	value: string,
	width: number,
	palette: AtelierPalette,
	role: PaletteRole = "primary",
): string[] {
	const prefix = `${label} `;
	const prefixWidth = visibleWidth(prefix);
	const valueWidth = Math.max(1, width - prefixWidth);
	const wrapped = wrapTextWithAnsi(palette.paint(role, value), valueWidth);
	return wrapped.map((line, index) =>
		index === 0 ? `${palette.paint("muted", label)} ${line}` : `${" ".repeat(prefixWidth)}${line}`,
	);
}

function progressRows(snapshot: SidebarSnapshot, palette: AtelierPalette, width: number): string[] {
	const observer = snapshot.progressObserver;
	const rows: string[] = [];
	if (!observer) return [palette.paint("dim", "Observer unavailable")];
	const status =
		observer.phase === "observing"
			? "Updating…"
			: observer.phase === "waiting"
				? "Waiting for activity"
				: observer.phase === "disabled"
					? "Disabled"
					: observer.phase === "unavailable"
						? "Unavailable"
						: observer.phase === "error"
							? "Update failed"
							: observer.stale
								? "Summary · stale"
								: "Summary";
	const role: PaletteRole =
		observer.phase === "error" || observer.phase === "unavailable"
			? "warning"
			: observer.phase === "ready"
				? "ready"
				: "dim";
	const heading = palette.paint(role, `${status} · ${display(observer.modelId)}`);
	rows.push(centeredTrackContent(heading, width, " "));
	if (observer.summary) {
		rows.push(...wrappedProgressValue("Now", observer.summary.current, width, palette));
		if (observer.summary.next)
			rows.push(...wrappedProgressValue("Next", observer.summary.next, width, palette));
		if (observer.summary.blockers)
			rows.push(...wrappedProgressValue("Blockers", observer.summary.blockers, width, palette, "warning"));
		rows.push(
			...wrappedProgressValue("Goal", observer.summary.goal, width, palette),
			...wrappedProgressValue("Done", observer.summary.progress, width, palette),
		);
	}
	if (observer.message) rows.push(...wrapTextWithAnsi(palette.paint("dim", observer.message), width));
	return rows;
}

function activityBandRows(
	snapshot: SidebarSnapshot,
	leadWidth: number,
	continuationWidth: number,
	layout: SidebarLayout,
	palette: AtelierPalette,
	theme: ThemeLike,
	now: number,
): string[] {
	const activity = snapshot.runActivity;
	const activeIds = new Set(activity.activeTools.map((tool) => tool.id));
	const tools = [
		...activity.activeTools
			.map((tool, index) => ({ index, tool }))
			.sort((left, right) => left.tool.startedAt - right.tool.startedAt || left.index - right.index)
			.map(({ tool }) => tool),
		...activity.recentTools.filter((tool) => !activeIds.has(tool.id)),
	];
	const rows: string[] = [];
	if (snapshot.autoModeState) {
		const auto = snapshot.autoModeState;
		rows.push(
			centeredTrackContent(
				palette.paint(
					auto.enabled ? "ready" : "dim",
					`${auto.enabled ? "⏵⏵ auto" : "⏸ manual"} · ${auto.modelId}`,
				),
				leadWidth,
				" ",
			),
		);
	}
	if (activity.phase === "running") {
		rows.push(
			...turnTrackRows(activity, palette, theme, leadWidth, now),
			turnTrackBottomRow(activity, snapshot.autoModeState, palette, theme, leadWidth),
		);
	} else {
		const aggregate = aggregateActivityText(activity, layout.compact);
		const summary = runSummaryRow(activity, palette, now);
		rows.push(
			aggregate
				? spacedRow(
						summary,
						palette.paint(activity.failedCount > 0 ? "error" : "ready", aggregate),
						leadWidth,
					)
				: summary,
		);
		if (snapshot.autoModeState) {
			const auto = snapshot.autoModeState;
			rows.push(
				`${palette.paint("permissionAuto", `󰚩 ${auto.allowed} allow`)} ${palette.paint("dim", "·")} ${palette.paint(
					"permissionHuman",
					`󰀄 ${auto.asked} asked`,
				)}`,
			);
		}
	}
	rows.push(responsePerformanceRow(activity, palette));
	for (const tool of tools) rows.push(...toolActivityRows(tool, continuationWidth, palette, now));
	for (const permission of activity.standalonePermissions ?? []) {
		rows.push(...standalonePermissionRows(permission, continuationWidth, palette));
	}
	return rows;
}

function renderProgressContent(
	snapshot: SidebarSnapshot,
	theme: ThemeLike,
	width: number,
	colorEnabled = true,
): string[] {
	const safeWidth = Math.max(1, Math.trunc(width));
	const palette = createPalette(theme, colorEnabled);
	return progressRows(snapshot, palette, safeWidth).map((row) => truncateToWidth(row, safeWidth, ""));
}

export function renderProgressLines(
	snapshot: SidebarSnapshot,
	theme: ThemeLike,
	width: number,
	height: number,
	colorEnabled = true,
): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const palette = createPalette(theme, colorEnabled);
	const contentWidth = Math.max(1, safeWidth - 2);
	return renderDock(
		renderProgressContent(snapshot, theme, contentWidth, colorEnabled),
		safeWidth,
		safeHeight,
		palette,
	);
}

function renderActivityContent(
	snapshot: SidebarSnapshot,
	theme: ThemeLike,
	width: number,
	colorEnabled = true,
	now = Date.now(),
): string[] {
	const safeWidth = Math.max(1, Math.trunc(width));
	const palette = createPalette(theme, colorEnabled);
	const layout = sidebarLayout(safeWidth + 2);
	return activityBandRows(snapshot, safeWidth, safeWidth, layout, palette, theme, now).map((row) =>
		truncateToWidth(row, safeWidth, ""),
	);
}

export function renderActivityLines(
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
	const contentWidth = Math.max(1, safeWidth - 2);
	return renderDock(
		renderActivityContent(snapshot, theme, contentWidth, colorEnabled, now),
		safeWidth,
		safeHeight,
		palette,
	);
}

export function renderSidebarLines(
	snapshot: SidebarSnapshot,
	theme: ThemeLike,
	width: number,
	height: number,
	colorEnabled = true,
	now = Date.now(),
): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	const regions = sidebarRegionHeights(height);
	if (regions.separator === 0)
		return renderActivityLines(snapshot, theme, safeWidth, regions.activity, colorEnabled, now);
	const palette = createPalette(theme, colorEnabled);
	const separator = `${palette.paint("dim", "├")}${palette.paint("dim", "─".repeat(Math.max(0, safeWidth - 1)))}`;
	return [
		...renderProgressLines(snapshot, theme, safeWidth, regions.progress, colorEnabled),
		separator,
		...renderActivityLines(snapshot, theme, safeWidth, regions.activity, colorEnabled, now),
	];
}

export function sidebarRegionHeights(height: number): {
	progress: number;
	separator: number;
	activity: number;
} {
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeHeight < 3) return { progress: 0, separator: 0, activity: safeHeight };
	const available = safeHeight - 1;
	const progress = Math.floor(available / 2);
	return { progress, separator: 1, activity: available - progress };
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
	const content = (section: "progress" | "activity"): Component => ({
		render(width) {
			try {
				return section === "progress"
					? renderProgressContent(options.getSnapshot(), options.theme, width, options.colorEnabled ?? true)
					: renderActivityContent(options.getSnapshot(), options.theme, width, options.colorEnabled ?? true);
			} catch (error) {
				return [sanitize(error instanceof Error ? error.message : String(error)) || "Sidebar unavailable"];
			}
		},
		invalidate() {},
	});
	const progress = new ScrollView(content("progress"), {
		primary: false,
		overscroll: "contain",
		scrollbar: "auto",
	});
	const activity = new ScrollView(content("activity"), {
		primary: false,
		overscroll: "contain",
		scrollbar: "auto",
	});
	const divider = (): Component => ({
		render: (width) => {
			const palette = createPalette(options.theme, options.colorEnabled ?? true);
			return [palette.paint("dim", "─".repeat(Math.max(1, width)))];
		},
		invalidate() {},
	});
	const rail: Component = {
		render: () => {
			const palette = createPalette(options.theme, options.colorEnabled ?? true);
			const regions = sidebarRegionHeights(options.getHeight());
			return Array.from({ length: options.getHeight() }, (_, index) =>
				palette.paint("dim", regions.separator === 1 && index === regions.progress ? "├" : "│"),
			);
		},
		invalidate() {},
	};
	const horizontalDivider = divider();
	const body = {
		render(width: number): string[] {
			const regions = sidebarRegionHeights(options.getHeight());
			if (regions.separator === 0) return activity.render(width);
			return [
				...progress.render(width).slice(0, regions.progress),
				...horizontalDivider.render(width),
				...activity.render(width).slice(0, regions.activity),
			];
		},
		invalidate() {
			progress.invalidate();
			horizontalDivider.invalidate();
			activity.invalidate();
		},
		[Symbol.for("@earendil-works/pi-tui/layout-node")]() {
			const regions = sidebarRegionHeights(options.getHeight());
			return {
				type: "vstack" as const,
				gap: 0,
				align: "stretch" as const,
				entries:
					regions.separator === 0
						? [{ component: activity, basis: regions.activity, grow: 0, shrink: 0 }]
						: [
								{ component: progress, basis: regions.progress, grow: 0, shrink: 0 },
								{ component: horizontalDivider, basis: 1, grow: 0, shrink: 0 },
								{ component: activity, basis: regions.activity, grow: 0, shrink: 0 },
							],
			};
		},
	};
	class SidebarShell extends HStack {
		override render(width: number): string[] {
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
		}
	}
	return new SidebarShell([
		{ component: rail, basis: 1, grow: 0, shrink: 0, minSize: 1, maxSize: 1 },
		{ component: body, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
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
