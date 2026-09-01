import type { ObserverConfig } from "./config.js";
import type { ObserverSnapshot, ProgressSummary } from "./events.js";

export interface SchedulerOptions {
	config: ObserverConfig;
	modelId: string;
	onState(snapshot: ObserverSnapshot): void;
	run(
		signal: AbortSignal,
		previous?: ProgressSummary,
	): Promise<
		| { kind: "success"; summary: ProgressSummary }
		| { kind: "cancelled" }
		| { kind: "error" | "unavailable"; message: string }
	>;
	now?: () => number;
}

export interface ObserverScheduler {
	turnEnded(revision: string): void;
	refresh(): void;
	reset(options?: { regenerate?: boolean }): void;
	setEnabled(enabled: boolean): void;
	setUnavailable(message: string): void;
	setConfig(config: ObserverConfig, modelId: string): void;
	dispose(): void;
}

export function createObserverScheduler(options: SchedulerOptions): ObserverScheduler {
	let config = options.config;
	let modelId = options.modelId;
	let enabled = config.enabledByDefault;
	let disposed = false;
	let completedTurns = 0;
	let turnsAtLastRun = 0;
	let lastRunAt: number | undefined;
	let lastSummary: ProgressSummary | undefined;
	let lastObservedRevision: string | undefined;
	let generation = 0;
	let active: AbortController | undefined;
	let pending = false;
	let pendingRevision: string | undefined;
	const now = options.now ?? Date.now;

	const publish = (snapshot: Omit<ObserverSnapshot, "version" | "modelId">): void => {
		if (disposed) return;
		options.onState({ version: 1, modelId, ...snapshot });
	};
	const waiting = (): void => publish(enabled ? { phase: "waiting" } : { phase: "disabled" });

	const dispatch = (revision = pendingRevision): void => {
		if (disposed || !enabled) return;
		if (revision !== undefined && revision === lastObservedRevision) return;
		if (active) {
			pending = true;
			pendingRevision = revision;
			return;
		}
		const controller = new AbortController();
		active = controller;
		pending = false;
		pendingRevision = undefined;
		const expectedGeneration = generation;
		const startedAt = now();
		const turnsAtStart = completedTurns;
		publish({ phase: "observing", ...(lastSummary ? { summary: lastSummary, stale: true } : {}) });
		void options
			.run(controller.signal, lastSummary)
			.then((result) => {
				if (disposed || expectedGeneration !== generation || controller.signal.aborted) return;
				lastRunAt = startedAt;
				turnsAtLastRun = turnsAtStart;
				lastObservedRevision = revision;
				if (result.kind === "success") {
					lastSummary = result.summary;
					publish({ phase: "ready", summary: result.summary, updatedAt: now() });
				} else if (result.kind === "error" || result.kind === "unavailable") {
					publish({
						phase: result.kind,
						message: result.message,
						...(lastSummary ? { summary: lastSummary, stale: true } : {}),
					});
				}
			})
			.finally(() => {
				if (active === controller) active = undefined;
				if (disposed || expectedGeneration !== generation) return;
				if (pending) dispatch(pendingRevision);
			});
	};

	const scheduler: ObserverScheduler = {
		turnEnded(revision) {
			if (disposed || !enabled) return;
			completedTurns += 1;
			const first = lastRunAt === undefined && completedTurns === 1;
			const turnsDue = completedTurns - turnsAtLastRun >= config.turnInterval;
			const timeDue = lastRunAt !== undefined && now() - lastRunAt >= config.maxAgeMs;
			if (first || turnsDue || timeDue) dispatch(revision);
		},
		refresh() {
			// Manual refresh intentionally bypasses activity revision deduplication.
			dispatch();
		},
		reset(resetOptions = {}) {
			generation += 1;
			active?.abort();
			active = undefined;
			pending = false;
			pendingRevision = undefined;
			completedTurns = 0;
			turnsAtLastRun = 0;
			lastRunAt = undefined;
			lastObservedRevision = undefined;
			lastSummary = undefined;
			waiting();
			if (resetOptions.regenerate && enabled) dispatch();
		},
		setEnabled(next) {
			enabled = next;
			if (!enabled) {
				generation += 1;
				active?.abort();
				active = undefined;
				pending = false;
				pendingRevision = undefined;
				publish({ phase: "disabled" });
			} else {
				waiting();
			}
		},
		setUnavailable(message) {
			generation += 1;
			active?.abort();
			active = undefined;
			pending = false;
			pendingRevision = undefined;
			publish({
				phase: "unavailable",
				message,
				...(lastSummary ? { summary: lastSummary, stale: true } : {}),
			});
		},
		setConfig(next, nextModelId) {
			config = next;
			modelId = nextModelId;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			generation += 1;
			active?.abort();
			active = undefined;
			pending = false;
			pendingRevision = undefined;
		},
	};
	waiting();
	return scheduler;
}
