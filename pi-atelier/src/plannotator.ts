import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SidebarPanelContribution, SidebarPanelRow } from "./sidebar-panels.js";

export const PLANNOTATOR_PANEL_ID = "plannotator:progress" as const;
const MAX_ROWS = 24;
const MAX_ROW_CHARS = 160;
const DONE_MARKER = /\[DONE:(\d+)\]/gi;
const CHECKBOX = /^[-*]\s*\[([ xX])\]\s+(.+)$/gm;

export interface ProgressItem {
	step: number;
	text: string;
	completed: boolean;
}

export type PlannotatorSnapshot =
	| { phase: "planning"; planPath?: string }
	| {
			phase: "executing";
			planPath: string;
			items: ProgressItem[];
			completed: number;
			total: number;
	  };

export interface SessionEntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
	message?: unknown;
}

interface PlannotatorState {
	phase?: unknown;
	lastSubmittedPath?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function realpathThroughExistingAncestor(path: string): string {
	let current = resolve(path);
	const missing: string[] = [];
	for (;;) {
		try {
			return resolve(realpathSync(current), ...missing);
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(path);
			missing.unshift(current.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
			current = parent;
		}
	}
}

export function resolvePlanPath(cwd: string, submittedPath: string): string | undefined {
	if (![".md", ".mdx"].includes(extname(submittedPath).toLowerCase())) return undefined;
	const root = realpathThroughExistingAncestor(cwd);
	const candidate = realpathThroughExistingAncestor(resolve(cwd, submittedPath));
	const rel = relative(root, candidate);
	if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
		return undefined;
	}
	return candidate;
}

export function validateReadablePlanPath(cwd: string, submittedPath: unknown): string | undefined {
	if (typeof submittedPath !== "string" || !submittedPath.trim()) return undefined;
	const candidate = resolvePlanPath(cwd, submittedPath.trim());
	if (!candidate) return undefined;
	try {
		if (!statSync(candidate).isFile()) return undefined;
		readFileSync(candidate, "utf8");
		return submittedPath.trim();
	} catch {
		return undefined;
	}
}

export function parseChecklist(markdown: string): ProgressItem[] {
	const items: ProgressItem[] = [];
	for (const match of markdown.matchAll(CHECKBOX)) {
		const text = match[2]?.trim();
		if (text) items.push({ step: items.length + 1, text, completed: match[1] !== " " });
	}
	return items;
}

export function assistantText(message: unknown): string {
	const value = record(message);
	if (value?.role !== "assistant" || !Array.isArray(value.content)) return "";
	return value.content
		.map((part) => record(part))
		.filter((part): part is Record<string, unknown> => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

export function applyDoneMarkers(text: string, items: ProgressItem[]): void {
	for (const match of text.matchAll(DONE_MARKER)) {
		const step = Number(match[1]);
		const item = items.find((candidate) => candidate.step === step);
		if (item) item.completed = true;
	}
}

/** Reconstruct Plannotator's active phase from the current branch only. */
export function reconstructPlannotator(
	cwd: string,
	entries: readonly SessionEntryLike[],
	transientPlanPath?: string,
	readPlan: (path: string) => string = (path) => readFileSync(path, "utf8"),
): PlannotatorSnapshot | undefined {
	let state: PlannotatorState | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "plannotator") {
			state = record(entry.data) as PlannotatorState | undefined;
		}
	}
	if (state?.phase === "planning") {
		const submitted =
			typeof state.lastSubmittedPath === "string" ? state.lastSubmittedPath : transientPlanPath;
		const planPath = submitted ? validateReadablePlanPath(cwd, submitted) : undefined;
		return { phase: "planning", ...(planPath ? { planPath } : {}) };
	}
	if (state?.phase !== "executing" || typeof state.lastSubmittedPath !== "string") return undefined;

	const planPath = resolvePlanPath(cwd, state.lastSubmittedPath);
	if (!planPath) return undefined;
	let items: ProgressItem[];
	try {
		items = parseChecklist(readPlan(planPath));
	} catch {
		return undefined;
	}
	if (items.length === 0) return undefined;

	let executeIndex = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "custom" && entry.customType === "plannotator-execute") {
			executeIndex = index;
			break;
		}
	}
	for (let index = executeIndex + 1; index < entries.length; index++) {
		const entry = entries[index];
		if (entry?.type === "message") applyDoneMarkers(assistantText(entry.message), items);
	}
	const completed = items.filter((item) => item.completed).length;
	return {
		phase: "executing",
		planPath: state.lastSubmittedPath,
		items,
		completed,
		total: items.length,
	};
}

function bounded(value: string, limit = MAX_ROW_CHARS): string {
	const clean = value
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const points = Array.from(clean);
	return points.length <= limit ? clean : `${points.slice(0, limit - 1).join("")}…`;
}

export function plannotatorPanel(snapshot: PlannotatorSnapshot): SidebarPanelContribution {
	if (snapshot.phase === "planning") {
		return {
			id: PLANNOTATOR_PANEL_ID,
			title: "Plannotator",
			role: "warning",
			rows: [
				{ text: "⏸ Planning", role: "warning" },
				...(snapshot.planPath ? [{ text: bounded(snapshot.planPath), role: "muted" as const }] : []),
			],
		};
	}
	const rows: SidebarPanelRow[] = [
		{
			text: `${snapshot.completed}/${snapshot.total} complete`,
			role: snapshot.completed === snapshot.total ? "ready" : "accent",
		},
	];
	const available = MAX_ROWS - rows.length;
	const visible = snapshot.items.slice(0, available);
	for (const item of visible) {
		rows.push({
			text: bounded(`${item.completed ? "✓" : "○"} ${item.step}. ${item.text}`),
			role: item.completed ? "dim" : "primary",
		});
	}
	if (snapshot.items.length > visible.length) {
		rows[rows.length - 1] = {
			text: `… ${snapshot.items.length - visible.length + 1} more steps`,
			role: "muted",
		};
	}
	return { id: PLANNOTATOR_PANEL_ID, title: "Plan progress", rows, role: "accent" };
}

export interface PlannotatorIntegration {
	getSnapshot(ctx: ExtensionContext): PlannotatorSnapshot | undefined;
	onToolStart(event: { toolName: string; args?: unknown }, ctx: ExtensionContext): void;
	onToolEnd(event: { toolName: string }, ctx: ExtensionContext): void;
	scheduleRefresh(ctx: ExtensionContext, requestRender: () => void): void;
	dispose(): void;
}

export function createPlannotatorIntegration(): PlannotatorIntegration {
	let transientPlanPath: string | undefined;
	let generation = 0;
	const timers = new Set<ReturnType<typeof setTimeout>>();

	const clearWidget = (ctx: ExtensionContext): void => {
		try {
			ctx.ui.setWidget("plannotator-progress", undefined);
		} catch {
			// Session replacement can invalidate a captured context between events.
		}
	};

	return {
		getSnapshot: (ctx) => reconstructPlannotator(ctx.cwd, ctx.sessionManager.getBranch(), transientPlanPath),
		onToolStart(event, ctx) {
			if (event.toolName !== "plannotator_submit_plan") return;
			const args = record(event.args);
			transientPlanPath = validateReadablePlanPath(ctx.cwd, args?.filePath);
		},
		onToolEnd(event, ctx) {
			if (event.toolName === "plannotator_submit_plan") transientPlanPath = undefined;
			clearWidget(ctx);
		},
		scheduleRefresh(ctx, requestRender) {
			const expected = generation;
			const timer = setTimeout(() => {
				timers.delete(timer);
				if (expected !== generation) return;
				clearWidget(ctx);
				try {
					requestRender();
				} catch {
					// Session replacement can retire the host between scheduling and refresh.
				}
			}, 0);
			timer.unref?.();
			timers.add(timer);
		},
		dispose() {
			generation += 1;
			transientPlanPath = undefined;
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
		},
	};
}
