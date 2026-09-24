import { expect, it, vi } from "vitest";
import {
	createQualityActivityPublisher,
	MAX_QUALITY_ACTIVITY_CALLS,
	QUALITY_ACTIVITY_CHANNEL,
	QUALITY_ACTIVITY_DISCOVER_CHANNEL,
	QUALITY_STATUS_CHANNEL,
	type QualityActivityEvent,
	type QualityHeaderEvent,
} from "./activity.js";

function harness() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const received: QualityActivityEvent[] = [];
	const headers: QualityHeaderEvent[] = [];
	const events = {
		on(channel: string, listener: (data: unknown) => void) {
			const group = listeners.get(channel) ?? new Set();
			group.add(listener);
			listeners.set(channel, group);
			return () => {
				group.delete(listener);
			};
		},
		emit(channel: string, value: unknown) {
			for (const listener of listeners.get(channel) ?? []) listener(value);
		},
	};
	events.on(QUALITY_ACTIVITY_CHANNEL, (data) => received.push(data as QualityActivityEvent));
	events.on(QUALITY_STATUS_CHANNEL, (data) => headers.push(data as QualityHeaderEvent));
	const publisher = createQualityActivityPublisher(events);
	publisher.reset("session-a");
	return { events, received, headers, publisher };
}

it("replays a standalone header without requiring a tool call", () => {
	const h = harness();
	h.publisher.updateHeader({ phase: "ready" }, "provider/model");
	expect(h.received).toEqual([]);
	expect(h.headers).toHaveLength(1);
	expect(h.headers[0]).toEqual({
		version: 1,
		sessionId: "session-a",
		revision: 1,
		phase: "ready",
		modelId: "provider/model",
	});
	h.headers.length = 0;
	h.events.emit(QUALITY_ACTIVITY_DISCOVER_CHANNEL, { version: 1, sessionId: "session-a" });
	expect(h.headers).toHaveLength(1);
	expect(h.headers[0]?.phase).toBe("ready");
});

it("deduplicates long header model IDs after applying the published bound", () => {
	const h = harness();
	const longModelId = "m".repeat(300);
	h.publisher.updateHeader({ phase: "ready" }, longModelId);
	h.publisher.updateHeader({ phase: "ready" }, longModelId);
	expect(h.headers).toHaveLength(1);
	expect(h.headers[0]?.modelId).toHaveLength(240);
});

it("later header changes do not rewrite completed call history", () => {
	const h = harness();
	h.publisher.begin("edit-a");
	h.publisher.finishCollection();
	h.publisher.update({ phase: "approved" });
	h.received.length = 0;
	h.publisher.updateHeader({ phase: "disabled" }, "provider/model");
	h.publisher.update({ phase: "disabled" });
	expect(h.received).toEqual([]);
	expect(h.headers.at(-1)?.phase).toBe("disabled");
});

it("updates every collected call after the batch boundary", () => {
	const h = harness();
	h.publisher.begin("edit-a");
	h.publisher.begin("write-b");
	h.publisher.update({ phase: "checking" });
	expect(h.received.map((event) => event.phase)).toEqual(["pending", "pending"]);
	h.publisher.finishCollection();
	h.publisher.update({ phase: "checking", reviewAttempt: 1 });
	h.publisher.update({ phase: "approved" });
	expect(h.received.slice(-2)).toMatchObject([
		{ toolCallId: "edit-a", phase: "approved" },
		{ toolCallId: "write-b", phase: "approved" },
	]);
});

it("preserves the previous batch verdict when a correction batch starts", () => {
	const h = harness();
	h.publisher.begin("original");
	h.publisher.finishCollection();
	h.publisher.update({ phase: "needs_work", correctionAttempt: 0, correctionLimit: 5 });
	h.publisher.begin("correction");
	h.publisher.finishCollection();
	h.publisher.update({ phase: "approved" });
	h.received.length = 0;
	h.events.emit(QUALITY_ACTIVITY_DISCOVER_CHANNEL, { version: 1, sessionId: "session-a" });
	expect(h.received).toMatchObject([
		{ toolCallId: "original", phase: "needs_work" },
		{ toolCallId: "correction", phase: "approved" },
	]);
});

it("does not overwrite excluded and failed calls with the batch verdict", () => {
	const h = harness();
	h.publisher.begin("lockfile");
	h.publisher.finishTool("lockfile", "excluded");
	h.publisher.begin("failed");
	h.publisher.finishTool("failed", "not_reviewed");
	h.publisher.begin("source");
	h.publisher.finishCollection();
	h.publisher.update({ phase: "approved" });
	expect(h.received.at(-1)).toMatchObject({ toolCallId: "source", phase: "approved" });
	expect(h.received.filter((event) => event.phase === "approved")).toHaveLength(1);
});

it("bounds replay, rejects another session, and retires listeners", () => {
	const h = harness();
	for (let i = 0; i < MAX_QUALITY_ACTIVITY_CALLS + 5; i++) h.publisher.finishTool(`call-${i}`, "excluded");
	h.received.length = 0;
	h.events.emit(QUALITY_ACTIVITY_DISCOVER_CHANNEL, { version: 1, sessionId: "other" });
	expect(h.received).toEqual([]);
	h.events.emit(QUALITY_ACTIVITY_DISCOVER_CHANNEL, { version: 1, sessionId: "session-a" });
	expect(h.received).toHaveLength(MAX_QUALITY_ACTIVITY_CALLS);
	h.publisher.reset("session-b");
	h.publisher.finishCollection();
	h.received.length = 0;
	h.publisher.update({ phase: "approved" });
	expect(h.received).toEqual([]);
	h.publisher.dispose();
	h.events.emit(QUALITY_ACTIVITY_DISCOVER_CHANNEL, { version: 1, sessionId: "session-b" });
	expect(h.received).toEqual([]);
});

it("a failing presentation consumer cannot interrupt the gate publisher", () => {
	const h = harness();
	const badListener = vi.fn(() => {
		throw new Error("UI unavailable");
	});
	h.events.on(QUALITY_ACTIVITY_CHANNEL, badListener);
	expect(() => h.publisher.begin("edit-a")).not.toThrow();
	h.publisher.finishCollection();
	expect(() => h.publisher.update({ phase: "approved" })).not.toThrow();
});
