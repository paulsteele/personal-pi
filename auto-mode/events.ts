import type { AutoModeSnapshot, DecisionRecord } from "./core.ts";

/** Private event seam between auto mode and the local Atelier fork. */
export const AUTO_MODE_STATE_CHANNEL = "auto-mode:state" as const;
export const AUTO_MODE_DECISION_CHANNEL = "auto-mode:decision" as const;
export const AUTO_MODE_DISCOVER_CHANNEL = "auto-mode:discover" as const;

export interface AutoModeEventTransport {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export interface AutoModeDecisionEvent {
	requestId: string;
	toolCallId: string | null;
	surface: string;
	value: string;
	verdict: "allow" | "deny" | "defer";
	reason: string | null;
	deferReason: string | null;
	at: number;
}

/** Bounded publisher with discovery replay so extension load order is irrelevant. */
export interface AutoModePublisher {
	update(snapshot: AutoModeSnapshot): void;
	decision(record: DecisionRecord, toolCallId: string | null): void;
	dispose(): void;
}

const MAX_TEXT = 500;

function clean(value: unknown, max = MAX_TEXT): string | null {
	if (typeof value !== "string") return null;
	const text = value
		.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return null;
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function publishAutoMode(events: AutoModeEventTransport): AutoModePublisher {
	let current: AutoModeSnapshot | undefined;
	let disposed = false;
	const emitState = () => {
		if (disposed || !current) return;
		try {
			events.emit(AUTO_MODE_STATE_CHANNEL, current);
		} catch {
			// Observational transport only.
		}
	};
	const unsubscribe = events.on(AUTO_MODE_DISCOVER_CHANNEL, () => emitState());
	return {
		update(snapshot) {
			if (disposed) return;
			current = snapshot;
			emitState();
		},
		decision(record, toolCallId) {
			if (disposed) return;
			const requestId = clean(record.requestId, 160);
			const surface = clean(record.surface, 100);
			if (!requestId || !surface) return;
			const event: AutoModeDecisionEvent = {
				requestId,
				toolCallId: clean(toolCallId, 160),
				surface,
				value: clean(record.value) ?? "",
				verdict: record.verdict,
				reason: clean(record.reason),
				deferReason: clean(record.deferReason, 100),
				at: Number.isFinite(record.at) ? Math.max(0, Math.trunc(record.at)) : Date.now(),
			};
			try {
				events.emit(AUTO_MODE_DECISION_CHANNEL, event);
			} catch {
				// Observational transport only.
			}
		},
		dispose() {
			disposed = true;
			current = undefined;
			try {
				unsubscribe();
			} catch {
				// Best effort teardown.
			}
		},
	};
}
