import { describe, expect, it } from "vitest";
import {
	createObserverPublisher,
	PROGRESS_OBSERVER_DISCOVER_CHANNEL,
	PROGRESS_OBSERVER_STATE_CHANNEL,
} from "./events.js";

function bus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel: string, handler: (data: unknown) => void) {
			const current = listeners.get(channel) ?? new Set();
			current.add(handler);
			listeners.set(channel, current);
			return () => current.delete(handler);
		},
		emit(channel: string, data: unknown) {
			for (const handler of listeners.get(channel) ?? []) handler(data);
		},
		count(channel: string) {
			return listeners.get(channel)?.size ?? 0;
		},
	};
}

describe("observer event protocol", () => {
	it("publishes and replays only in-memory state", () => {
		const events = bus();
		const publisher = createObserverPublisher(events);
		const received: unknown[] = [];
		events.on(PROGRESS_OBSERVER_STATE_CHANNEL, (state) => received.push(state));
		const snapshot = { version: 1 as const, phase: "waiting" as const, modelId: "provider/model" };
		publisher.update(snapshot);
		events.emit(PROGRESS_OBSERVER_DISCOVER_CHANNEL, { version: 1 });
		expect(received).toEqual([snapshot, snapshot]);
		publisher.dispose();
		expect(events.count(PROGRESS_OBSERVER_DISCOVER_CHANNEL)).toBe(0);
	});
});
