import { emptyUsage, type UsageTotals } from "./usage.js";
import type { Advisory, Checkpoint, Finding } from "./types.js";
import { awaitWithSignal } from "./work-ui.js";
import { hash } from "./prompts.js";
import { deferToolCommit } from "./tool-commit.js";

export type TaskState =
	| "queued"
	| "running"
	| "compacting"
	| "retrying"
	| "blocked"
	| "permission"
	| "checking"
	| "waiting_slot"
	| "completed"
	| "cancelled"
	| "failed"
	| "skipped";
export interface TaskRecord {
	id: string;
	stage: string;
	name: string;
	files: string[];
	reason: string;
	state: TaskState;
	queuedAt: number;
	startedAt?: number;
	endedAt?: number;
	turns: number;
	requests: number;
	compactions: number;
	retries: number;
	activity: string;
	updatedAt: number;
	remaining?: number | undefined;
	total?: number | undefined;
	unreviewed?: string[] | undefined;
	usage: UsageTotals;
}
export interface TaskEvent {
	at: number;
	text: string;
}
export class TaskStore {
	readonly records = new Map<string, TaskRecord>();
	readonly events = new Map<string, TaskEvent[]>();
	private listeners = new Set<() => void>();
	private permissionWaits = new Map<string, { prior: TaskState; requests: Set<string> }>();
	peakActive = 0;
	phase = "Starting review";
	progress = "";
	model = "";
	journalPath?: string;
	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
	private emit() {
		this.peakActive = Math.max(
			this.peakActive,
			[...this.records.values()].filter((t) =>
				["running", "compacting", "retrying", "checking"].includes(t.state),
			).length,
		);
		for (const fn of this.listeners) {
			try {
				fn();
			} catch {
				/* presentation must not stop work */
			}
		}
	}
	setPhase(phase: string) {
		this.phase = phase;
		this.progress = "";
		this.emit();
	}
	setProgress(message: string) {
		if (this.progress === message) return;
		this.progress = message;
		this.emit();
	}
	add(task: Pick<TaskRecord, "id" | "stage" | "name" | "files" | "reason">) {
		if (this.records.has(task.id)) throw new Error(`Duplicate task: ${task.id}`);
		const now = Date.now();
		this.records.set(task.id, {
			...task,
			files: [...task.files],
			state: "queued",
			queuedAt: now,
			updatedAt: now,
			turns: 0,
			requests: 0,
			compactions: 0,
			retries: 0,
			activity: "Queued",
			usage: emptyUsage(),
		});
		this.emit();
	}
	update(id: string, patch: Partial<TaskRecord>, event?: string) {
		const task = this.records.get(id);
		if (!task || task.state === "cancelled") return;
		Object.assign(task, patch, { updatedAt: Date.now() });
		if (event) {
			task.activity = event;
			const events = this.events.get(id) ?? [];
			events.push({ at: Date.now(), text: event });
			this.events.set(id, events.slice(-20));
		}
		this.emit();
	}
	permission(event: { taskId: string; requestId: string; state: "queued" | "showing" | "finished" }) {
		const task = this.records.get(event.taskId);
		if (!task || ["cancelled", "completed", "failed", "skipped"].includes(task.state)) return;
		let wait = this.permissionWaits.get(task.id);
		if (event.state === "finished") {
			wait?.requests.delete(event.requestId);
			if (wait && !wait.requests.size) {
				this.permissionWaits.delete(task.id);
				if (task.state === "permission")
					this.update(task.id, { state: wait.prior }, "Permission review finished");
			}
			return;
		}
		if (!wait) {
			wait = { prior: task.state, requests: new Set() };
			this.permissionWaits.set(task.id, wait);
		}
		wait.requests.add(event.requestId);
		this.update(
			task.id,
			{ state: "permission" },
			event.state === "showing" ? "Awaiting human permission" : "Permission approval queued",
		);
	}
	cancel() {
		this.permissionWaits.clear();
		for (const task of this.records.values())
			if (task.state !== "completed" && task.state !== "skipped")
				this.update(task.id, { state: "cancelled", endedAt: Date.now() }, "Cancelled");
	}
	snapshot(): TaskRecord[] {
		return structuredClone([...this.records.values()]);
	}
}

/** One session-scoped recovery decision, even when several workers fail concurrently. */
export class RecoveryGate {
	private pending: Promise<void> | undefined;
	private resume: (() => void) | undefined;
	readonly blockers = new Map<string, string>();
	constructor(
		readonly store: TaskStore,
		readonly signal: AbortSignal,
	) {}
	async wait(): Promise<void> {
		this.signal.throwIfAborted();
		if (this.pending) await awaitWithSignal(this.pending, this.signal);
		this.signal.throwIfAborted();
	}
	async block(id: string, reason: string, resumeState: "retrying" | "queued" = "retrying"): Promise<void> {
		this.blockers.set(id, reason);
		if (!this.pending)
			this.pending = new Promise((resolve) => {
				this.resume = resolve;
			});
		this.store.update(id, { state: "blocked" }, reason);
		this.store.setPhase("Blocked task: /pr retry or /pr cancel; other workers may continue");
		await this.wait();
		const task = this.store.records.get(id);
		if (task) this.store.update(id, { state: resumeState, retries: task.retries + 1 }, "Retry requested");
	}
	retry() {
		const resume = this.resume;
		this.pending = undefined;
		this.resume = undefined;
		this.blockers.clear();
		this.store.setPhase("Resuming review");
		resume?.();
	}
}

/** Coverage is host-owned. A summary or an undelivered preview cannot close an obligation. */
export class CoverageLedger {
	private resources = new Map<
		string,
		{ total?: number; ranges: Array<[number, number]>; reviewed: boolean }
	>();
	private checkpoints = new Map<string, string>();
	readonly findings: Finding[] = [];
	readonly advisories: Omit<Advisory, "id">[] = [];
	readonly notes: Array<{ key: string; notes: string }> = [];
	constructor(ids: string[]) {
		for (const id of new Set(ids)) this.resources.set(id, { ranges: [], reviewed: false });
	}
	deliver(id: string, start: number, end: number, total: number) {
		if (deferToolCommit(() => this.deliver(id, start, end, total))) return;
		const resource = this.resources.get(id);
		if (!resource) return;
		if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || end > total)
			throw new Error("Invalid coverage range");
		if (resource.total !== undefined && resource.total !== total)
			throw new Error("Captured resource changed");
		resource.total = total;
		const ranges = [...resource.ranges, [start, end] as [number, number]].sort((a, b) => a[0] - b[0]);
		resource.ranges = [];
		for (const range of ranges) {
			const last = resource.ranges.at(-1);
			if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
			else resource.ranges.push([...range]);
		}
		// Track delivered context automatically. The model need not acknowledge byte ranges.
		resource.reviewed = resource.ranges[0]?.[0] === 0 && resource.ranges[0]?.[1] === total;
	}
	checkpoint(value: Checkpoint): boolean {
		const serialized = JSON.stringify(value);
		const key = value.key ?? hash(serialized);
		const prior = this.checkpoints.get(key);
		if (prior !== undefined) {
			if (prior !== serialized) throw new Error("Checkpoint key reused with different data");
			return false;
		}
		for (const id of value.reviewed ?? []) {
			const r = this.resources.get(id);
			if (!r) throw new Error(`Unknown coverage ID: ${id}`);
			if (r.total === undefined || r.ranges[0]?.[0] !== 0 || r.ranges[0]?.[1] !== r.total)
				throw new Error(`Read all pages before acknowledging ${id}`);
		}
		if (deferToolCommit(() => this.checkpoint(JSON.parse(serialized) as Checkpoint))) return true;
		this.findings.push(...(value.findings ?? []));
		this.advisories.push(...(value.advisories ?? []));
		this.notes.push({ key, notes: value.notes ?? "Results saved" });
		this.checkpoints.set(key, serialized);
		return true;
	}
	get ids(): string[] {
		return [...this.resources.keys()];
	}
	resetDelivery() {
		for (const resource of this.resources.values()) {
			resource.ranges = [];
			delete resource.total;
			resource.reviewed = false;
		}
	}
	get remaining(): string[] {
		return [...this.resources].filter(([, r]) => !r.reviewed).map(([id]) => id);
	}
	get total(): number {
		return this.resources.size;
	}
	assertComplete() {
		if (this.remaining.length)
			throw new Error(
				`Context not yet supplied: ${this.remaining.slice(0, 20).join(", ")}. Read the remaining source before completing the review.`,
			);
	}
	page(offset = 0) {
		return {
			total: this.total,
			remaining: this.remaining.slice(offset, offset + 100),
			nextOffset: offset + 100 < this.remaining.length ? offset + 100 : null,
		};
	}
}
