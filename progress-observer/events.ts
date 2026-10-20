export const PROGRESS_OBSERVER_STATE_CHANNEL = "progress-observer:state";
export const PROGRESS_OBSERVER_DISCOVER_CHANNEL = "progress-observer:discover";
export const PROGRESS_OBSERVER_PROTOCOL_VERSION = 2 as const;

export type ObserverPhase = "waiting" | "observing" | "ready" | "error" | "disabled" | "unavailable";

export interface ProgressSummary {
	goal: string;
	current?: string;
	changed?: string;
	approach?: string;
	verification?: string;
	attention?: string;
	next?: string;
}

export interface ObservationBaseline {
	summary: ProgressSummary;
	entryId?: string;
}

export interface ObserverSnapshot {
	version: typeof PROGRESS_OBSERVER_PROTOCOL_VERSION;
	phase: ObserverPhase;
	modelId: string;
	updatedAt?: number;
	stale?: boolean;
	message?: string;
	summary?: ProgressSummary;
}

export interface EventTransport {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export function createObserverPublisher(events: EventTransport) {
	let snapshot: ObserverSnapshot | undefined;
	const unsubscribe = events.on(PROGRESS_OBSERVER_DISCOVER_CHANNEL, () => {
		if (snapshot) events.emit(PROGRESS_OBSERVER_STATE_CHANNEL, snapshot);
	});
	return {
		update(next: ObserverSnapshot) {
			snapshot = next;
			events.emit(PROGRESS_OBSERVER_STATE_CHANNEL, next);
		},
		dispose() {
			unsubscribe();
			snapshot = undefined;
		},
	};
}
