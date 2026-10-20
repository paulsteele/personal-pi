import type { ObserverConfig } from "./config.js";
import {
	PROGRESS_OBSERVER_PROTOCOL_VERSION,
	type ObservationBaseline,
	type ObserverSnapshot,
} from "./events.js";

const MILESTONE_DEBOUNCE_MS = 750;

export interface SchedulerOptions {
	config: ObserverConfig;
	modelId: string;
	onState(snapshot: ObserverSnapshot): void;
	run(
		signal: AbortSignal,
		previous?: ObservationBaseline,
	): Promise<
		| ({ kind: "success" } & ObservationBaseline)
		| { kind: "cancelled" }
		| { kind: "error" | "unavailable"; message: string }
	>;
	now?: () => number;
}

export interface ObserverScheduler {
	turnEnded(revision: string): void;
	milestone(revision: string): void;
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
	let baseline: ObservationBaseline | undefined;
	let updatedAt: number | undefined;
	let lastObservedRevision: string | undefined;
	let generation = 0;
	let active: AbortController | undefined;
	let pending = false;
	let pendingRevision: string | undefined;
	let milestoneTimer: ReturnType<typeof setTimeout> | undefined;
	const now = options.now ?? Date.now;

	const publish = (snapshot: Omit<ObserverSnapshot, "version" | "modelId">): void => {
		if (disposed) {
			return;
		}
		options.onState({ version: PROGRESS_OBSERVER_PROTOCOL_VERSION, modelId, ...snapshot });
	};
	const waiting = (): void => publish(enabled ? { phase: "waiting" } : { phase: "disabled" });
	const previousState = () =>
		baseline
			? { summary: baseline.summary, stale: true, ...(updatedAt !== undefined ? { updatedAt } : {}) }
			: {};
	const clearMilestone = (): void => {
		clearTimeout(milestoneTimer);
		milestoneTimer = undefined;
	};
	const cancelRequests = (): void => {
		generation += 1;
		active?.abort();
		active = undefined;
		pending = false;
		pendingRevision = undefined;
		clearMilestone();
	};

	const dispatch = (revision = pendingRevision): void => {
		if (disposed || !enabled || (revision !== undefined && revision === lastObservedRevision)) {
			return;
		}
		if (active) {
			pending = true;
			pendingRevision = revision;
			return;
		}
		clearMilestone();
		const controller = new AbortController();
		active = controller;
		pending = false;
		pendingRevision = undefined;
		const expectedGeneration = generation;
		const startedAt = now();
		const turnsAtStart = completedTurns;
		publish({ phase: "observing", ...previousState() });
		void options
			.run(controller.signal, baseline)
			.then((result) => {
				if (disposed || expectedGeneration !== generation || controller.signal.aborted) {
					return;
				}
				lastRunAt = startedAt;
				turnsAtLastRun = turnsAtStart;
				lastObservedRevision = revision;
				if (result.kind === "success") {
					baseline = { summary: result.summary, ...(result.entryId ? { entryId: result.entryId } : {}) };
					lastObservedRevision = revision ?? result.entryId;
					updatedAt = now();
					publish({ phase: "ready", summary: result.summary, updatedAt });
				} else if (result.kind === "error" || result.kind === "unavailable") {
					publish({ phase: result.kind, message: result.message, ...previousState() });
				}
			})
			.finally(() => {
				if (active === controller) {
					active = undefined;
				}
				if (disposed || expectedGeneration !== generation) {
					return;
				}
				if (pending) {
					dispatch(pendingRevision);
				}
			});
	};

	const scheduler: ObserverScheduler = {
		turnEnded(revision) {
			if (disposed || !enabled) {
				return;
			}
			completedTurns += 1;
			const turnsDue = completedTurns - turnsAtLastRun >= config.turnInterval;
			const timeDue = lastRunAt !== undefined && now() - lastRunAt >= config.maxAgeMs;
			if (turnsDue || timeDue) {
				dispatch(revision);
			}
		},
		milestone(revision) {
			if (disposed || !enabled || revision === lastObservedRevision) {
				return;
			}
			clearMilestone();
			milestoneTimer = setTimeout(() => {
				milestoneTimer = undefined;
				dispatch(revision);
			}, MILESTONE_DEBOUNCE_MS);
		},
		refresh() {
			clearMilestone();
			dispatch();
		},
		reset(resetOptions = {}) {
			cancelRequests();
			completedTurns = 0;
			turnsAtLastRun = 0;
			lastRunAt = undefined;
			lastObservedRevision = undefined;
			baseline = undefined;
			updatedAt = undefined;
			waiting();
			if (resetOptions.regenerate && enabled) {
				dispatch();
			}
		},
		setEnabled(next) {
			enabled = next;
			if (!enabled) {
				cancelRequests();
				publish({ phase: "disabled" });
			} else {
				waiting();
			}
		},
		setUnavailable(message) {
			cancelRequests();
			publish({ phase: "unavailable", message, ...previousState() });
		},
		setConfig(next, nextModelId) {
			config = next;
			modelId = nextModelId;
		},
		dispose() {
			disposed = true;
			cancelRequests();
		},
	};
	waiting();
	return scheduler;
}
