import { readFileSync, realpathSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";

export const ATELIER_PANEL_CHANNEL = "pi-atelier:sidebar-panels";
export const ATELIER_PANEL_VERSION = 1;
export const PANEL_ID = "plannotator:progress";
export const PANEL_SOURCE = "plannotator-sidebar";

const MAX_ROWS = 24;
const MAX_ROW_CHARS = 160;
const DONE_MARKER = /\[DONE:(\d+)\]/gi;
const CHECKBOX = /^[-*]\s*\[([ xX])\]\s+(.+)$/gm;

export type PanelRole =
	| "primary"
	| "accent"
	| "muted"
	| "dim"
	| "ready"
	| "working"
	| "warning"
	| "error";

export interface PanelRow {
	text: string;
	role?: PanelRole;
}

export interface ProgressItem {
	step: number;
	text: string;
	completed: boolean;
}

export interface ProgressSnapshot {
	planPath: string;
	items: ProgressItem[];
	completed: number;
	total: number;
}

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

/** Reconstruct the same active-plan view Plannotator rebuilds on resume/tree changes. */
export function reconstructProgress(
	cwd: string,
	entries: readonly SessionEntryLike[],
	readPlan: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ProgressSnapshot | undefined {
	let state: PlannotatorState | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "plannotator") {
			state = record(entry.data) as PlannotatorState | undefined;
		}
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
	return { planPath: state.lastSubmittedPath, items, completed, total: items.length };
}

function bounded(value: string, limit = MAX_ROW_CHARS): string {
	const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
	const points = Array.from(clean);
	return points.length <= limit ? clean : `${points.slice(0, limit - 1).join("")}…`;
}

export function snapshotRows(snapshot: ProgressSnapshot): PanelRow[] {
	const rows: PanelRow[] = [
		{ text: `${snapshot.completed}/${snapshot.total} complete`, role: snapshot.completed === snapshot.total ? "ready" : "accent" },
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
	return rows;
}

export function isAtelierDiscovery(value: unknown): value is { requestId: string } {
	const event = record(value);
	return (
		event?.version === ATELIER_PANEL_VERSION &&
		event.type === "discover" &&
		typeof event.requestId === "string" &&
		event.requestId.length > 0 &&
		event.requestId.length <= 256 &&
		!/[\u0000-\u001f\u007f-\u009f]/.test(event.requestId)
	);
}
