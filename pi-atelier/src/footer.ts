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
	type AtelierState,
	type DisplayValue,
	type FooterState,
} from "./types.js";

export interface ThemeLike {
	readonly name?: string;
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
}

const WORKING_DOT_FRAMES = ["...", "..", "."] as const;
const WORKING_ANIMATION_INTERVAL_MS = 400;

type FooterZone = "left" | "right";
type FooterItemId =
	| "plannotator"
	| "status"
	| "activity"
	| "model"
	| "thinking"
	| "git"
	| "input"
	| "output"
	| "performance"
	| "cache"
	| "cost"
	| "context";

interface FooterItem {
	id: FooterItemId;
	zone: FooterZone;
	full: string;
	compact: string;
	dropRank: number;
	required: boolean;
}

const DROP = {
	status: 0,
	git: 10,
	thinking: 10,
	cost: 20,
	model: 30,
	input: 40,
	output: 40,
	performance: 45,
	cache: 50,
	activity: Number.POSITIVE_INFINITY,
	context: Number.POSITIVE_INFINITY,
} as const;

const sanitize = (text: string): string =>
	text
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

function paintValue(value: DisplayValue, role: PaletteRole, palette: AtelierPalette): string {
	return palette.paint(value.available ? role : "dim", value.text);
}

function metric(label: string, value: DisplayValue, palette: AtelierPalette, role: PaletteRole): string {
	return `${palette.paint("muted", label)} ${paintValue(value, role, palette)}`;
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

function costValue(metrics: AtelierMetrics, decimals: number, compact: boolean): DisplayValue {
	if (!metrics.costAvailable || !Number.isFinite(metrics.cost)) return { text: "$—", available: false };
	const amount =
		compact && metrics.cost >= 1_000
			? formatTokens(metrics.cost)
			: metrics.cost.toFixed(compact ? Math.min(2, decimals) : decimals);
	return { text: `$${amount}`, available: true };
}

function contextRole(metrics: AtelierMetrics): PaletteRole {
	if (metrics.contextPercent === null || !Number.isFinite(metrics.contextPercent)) return "context";
	if (metrics.contextPercent >= CONTEXT_DANGER_PERCENT) return "error";
	if (metrics.contextPercent >= CONTEXT_WARNING_PERCENT) return "warning";
	return "context";
}

function activityText(
	state: AtelierState,
	palette: AtelierPalette,
	theme: ThemeLike,
	workingDots: string,
	compact: boolean,
): string {
	const fallback = state.activity.toUpperCase();
	const label = state.activity === "working" && !compact ? (state.workingLabel ?? fallback) : fallback;
	const dots =
		state.activity === "working" && !compact ? workingDots.padEnd(WORKING_DOT_FRAMES[0].length, " ") : "";
	const role: PaletteRole = state.activity === "working" ? "working" : "ready";
	return palette.paint(role, theme.bold(`● ${sanitize(label)}${dots}`));
}

function buildItems(
	state: FooterState,
	theme: ThemeLike,
	colorEnabled: boolean,
	workingDots: string,
): FooterItem[] {
	const palette = createPalette(theme, colorEnabled);
	const items: FooterItem[] = [];
	const add = (item: FooterItem): void => {
		if (!items.some((candidate) => candidate.id === item.id)) items.push(item);
	};

	const plannotator = state.plannotatorStatus
		? sanitize(stripTerminalSequences(state.plannotatorStatus))
		: "";
	if (plannotator) {
		const rendered = palette.paint(plannotator.includes("📋") ? "accent" : "warning", plannotator);
		add({
			id: "plannotator",
			zone: "left",
			full: rendered,
			compact: rendered,
			dropRank: Number.POSITIVE_INFINITY,
			required: true,
		});
	}

	add({
		id: "activity",
		zone: "left",
		full: activityText(state, palette, theme, workingDots, false),
		compact: activityText(state, palette, theme, workingDots, true),
		dropRank: DROP.activity,
		required: true,
	});

	const model = state.modelId ? sanitize(state.modelId) : "";
	if (model) {
		const rendered = palette.paint("primary", model);
		add({
			id: "model",
			zone: "left",
			full: rendered,
			compact: rendered,
			dropRank: DROP.model,
			required: false,
		});
	}
	const thinking = state.thinkingLevel ? sanitize(state.thinkingLevel) : "";
	if (thinking) {
		const rendered = palette.paint("muted", thinking);
		add({
			id: "thinking",
			zone: "left",
			full: rendered,
			compact: rendered,
			dropRank: DROP.thinking,
			required: false,
		});
	}
	const branch = state.branch ? sanitize(state.branch) : "";
	if (branch) {
		const rendered = `${palette.paint("primary", branch)}${state.dirty ? palette.paint("warning", "*") : ""}`;
		add({ id: "git", zone: "left", full: rendered, compact: rendered, dropRank: DROP.git, required: false });
	}
	const statuses = state.extensionStatuses.map(sanitize).filter(Boolean).join(" ");
	if (statuses) {
		const rendered = palette.paint("muted", statuses);
		add({
			id: "status",
			zone: "left",
			full: rendered,
			compact: rendered,
			dropRank: DROP.status,
			required: false,
		});
	}

	const metrics = state.metrics;
	const input = metric("in", availableValue(metrics.usageAvailable, metrics.input), palette, "input");
	const output = metric("out", availableValue(metrics.usageAvailable, metrics.output), palette, "output");
	const cache = metric("cache", percentValue(metrics.cacheHitPercent, 0), palette, "cache");
	const cost = `${paintValue(costValue(metrics, CURRENCY_DECIMALS, false), "cost", palette)}${
		metrics.subscription ? palette.paint("muted", " (sub)") : ""
	}`;
	add({ id: "input", zone: "right", full: input, compact: input, dropRank: DROP.input, required: false });
	add({ id: "output", zone: "right", full: output, compact: output, dropRank: DROP.output, required: false });
	add({ id: "cache", zone: "right", full: cache, compact: cache, dropRank: DROP.cache, required: false });
	add({ id: "cost", zone: "right", full: cost, compact: cost, dropRank: DROP.cost, required: false });

	const performance = responsePerformanceValues(state.performance);
	const renderedPerformance = [
		metric("TTFT", performance.ttft, palette, "output"),
		metric("TPS", performance.tps, palette, "output"),
	].join(palette.paint("muted", " · "));
	add({
		id: "performance",
		zone: "right",
		full: renderedPerformance,
		compact: renderedPerformance,
		dropRank: DROP.performance,
		required: false,
	});

	const contextPaletteRole = contextRole(metrics);
	const contextFull = `${metric("ctx", percentValue(metrics.contextPercent, 1), palette, contextPaletteRole)}${
		metrics.autoCompact === true ? palette.paint("muted", " (auto)") : ""
	}`;
	const contextCompact = metric("ctx", percentValue(metrics.contextPercent, 0), palette, contextPaletteRole);
	add({
		id: "context",
		zone: "right",
		full: contextFull,
		compact: contextCompact,
		dropRank: DROP.context,
		required: true,
	});

	return items;
}

function renderItems(items: FooterItem[], compactIds: Set<FooterItemId>, separator: string): string {
	return items
		.map((item) => (compactIds.has(item.id) ? item.compact : item.full))
		.filter(Boolean)
		.join(separator);
}

function compose(items: FooterItem[], width: number): string {
	const active = [...items];
	const compactIds = new Set<FooterItemId>();
	const left = () =>
		renderItems(
			active.filter((item) => item.zone === "left"),
			compactIds,
			" · ",
		);
	const right = () =>
		renderItems(
			active.filter((item) => item.zone === "right"),
			compactIds,
			"  ",
		);
	const measured = () => visibleWidth(left()) + visibleWidth(right()) + (left() && right() ? 2 : 0);

	const droppable = active.filter((item) => !item.required).sort((a, b) => a.dropRank - b.dropRank);
	for (const item of droppable) {
		if (measured() <= width) break;
		const index = active.findIndex((candidate) => candidate.id === item.id);
		if (index >= 0) active.splice(index, 1);
	}

	for (const item of active.filter((candidate) => candidate.required)) {
		if (measured() <= width) break;
		if (item.full !== item.compact) compactIds.add(item.id);
	}

	const leftText = left();
	const rightText = right();
	const gap = width - visibleWidth(leftText) - visibleWidth(rightText);
	if (leftText && rightText && gap >= 2) return `${leftText}${" ".repeat(gap)}${rightText}`;
	return truncateToWidth([leftText, rightText].filter(Boolean).join("  "), width, "");
}

export function renderFooterLine(
	state: FooterState,
	theme: ThemeLike,
	width: number,
	colorEnabled = true,
	workingDots = "...",
): string {
	if (width <= 0) return "";
	const line = compose(buildItems(state, theme, colorEnabled, workingDots), width);
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
	let frameIndex = 0;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	const unsubscribe = options.onBranchChange(options.requestRender);

	const stopAnimation = (): void => {
		if (animationTimer) {
			clearInterval(animationTimer);
			animationTimer = undefined;
		}
		frameIndex = 0;
	};

	const syncAnimation = (visible: boolean): void => {
		if (disposed || !visible) {
			stopAnimation();
			return;
		}
		if (animationTimer) return;
		animationTimer = setInterval(() => {
			if (disposed) return;
			frameIndex = (frameIndex + 1) % WORKING_DOT_FRAMES.length;
			options.requestRender();
		}, WORKING_ANIMATION_INTERVAL_MS);
	};

	return {
		render(width) {
			// Read live state even while visually hidden: the host uses this pass to
			// refresh extension statuses consumed by the sidebar.
			const state = options.getState();
			if (options.isSidebarPresented?.()) {
				syncAnimation(false);
				return [];
			}
			const colorEnabled = options.colorEnabled ?? true;
			const workingDots = WORKING_DOT_FRAMES[frameIndex] ?? WORKING_DOT_FRAMES[0];
			const line = renderFooterLine(state, options.theme, width, colorEnabled, workingDots);
			const fullActivity = activityText(
				state,
				createPalette(options.theme, colorEnabled),
				options.theme,
				workingDots,
				false,
			);
			syncAnimation(state.activity === "working" && line.includes(fullActivity));
			return [line];
		},
		invalidate() {},
		dispose() {
			if (disposed) return;
			disposed = true;
			stopAnimation();
			unsubscribe();
		},
	};
}
