import { expect, it, vi } from "vitest";
import {
	createQualityActivityPublisher,
	MAX_QUALITY_ACTIVITY_CALLS,
	QUALITY_ACTIVITY_CHANNEL,
	QUALITY_ACTIVITY_DISCOVER_CHANNEL,
	QUALITY_STATUS_CHANNEL,
	QUALITY_ATTENTION_CHANNEL,
	type QualityAttentionEvent,
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

it("publishes matching attention start/end events once", () => {
	const h = harness();
	const attention: QualityAttentionEvent[] = [];
	h.events.on(QUALITY_ATTENTION_CHANNEL, (raw) => attention.push(raw as QualityAttentionEvent));
	const finishArbitration = h.publisher.requestDecision("arbitration");
	const finishCoverage = h.publisher.requestDecision("coverage");
	expect(attention).toMatchObject([
		{ version: 1, sessionId: "session-a", kind: "arbitration", active: true },
		{ version: 1, sessionId: "session-a", kind: "coverage", active: true },
	]);
	expect(attention[0]!.requestId).not.toBe(attention[1]!.requestId);
	finishArbitration();
	finishArbitration();
	expect(attention).toHaveLength(3);
	expect(attention[2]).toEqual({ ...attention[0], active: false });
	finishCoverage();
	expect(attention).toHaveLength(4);
	expect(attention[3]).toEqual({ ...attention[1], active: false });
});

it("ends active attention requests when the session resets", () => {
	const h = harness();
	const attention: QualityAttentionEvent[] = [];
	h.events.on(QUALITY_ATTENTION_CHANNEL, (raw) => attention.push(raw as QualityAttentionEvent));
	const finishCoverage = h.publisher.requestDecision("coverage");
	h.publisher.reset("session-b");
	expect(attention).toEqual([
		{
			version: 1,
			sessionId: "session-a",
			kind: "coverage",
			requestId: attention[0]!.requestId,
			active: true,
		},
		{ ...attention[0], active: false },
	]);
	finishCoverage();
	expect(attention).toHaveLength(2);
});

it("ends active attention requests when the publisher is disposed", () => {
	const h = harness();
	const attention: QualityAttentionEvent[] = [];
	h.events.on(QUALITY_ATTENTION_CHANNEL, (raw) => attention.push(raw as QualityAttentionEvent));
	const finishFailure = h.publisher.requestDecision("failure");
	h.publisher.dispose();
	expect(attention[1]).toEqual({ ...attention[0], active: false });
	finishFailure();
	expect(attention).toHaveLength(2);
	h.publisher.requestDecision("scope")();
	expect(attention).toHaveLength(2);
});

it("keeps attention consumers non-authoritative", () => {
	const h = harness();
	h.events.on(QUALITY_ATTENTION_CHANNEL, () => {
		throw new Error("notifier unavailable");
	});
	const finish = h.publisher.requestDecision("failure");
	expect(finish).not.toThrow();
});

it("replays a standalone header without requiring a tool call", () => {
	const h = harness();
	h.publisher.updateHeader({ phase: "ready" }, "provider/model", { checkCount: 0, rejectionCount: 0 });
	expect(h.received).toEqual([]);
	expect(h.headers).toHaveLength(1);
	expect(h.headers[0]).toEqual({
		version: 1,
		sessionId: "session-a",
		revision: 1,
		phase: "ready",
		modelId: "provider/model",
		checkCount: 0,
		rejectionCount: 0,
	});
	h.headers.length = 0;
	h.events.emit(QUALITY_ACTIVITY_DISCOVER_CHANNEL, { version: 1, sessionId: "session-a" });
	expect(h.headers).toHaveLength(1);
	expect(h.headers[0]?.phase).toBe("ready");
});

it("deduplicates long header model IDs after applying the published bound", () => {
	const h = harness();
	const longModelId = "m".repeat(300);
	h.publisher.updateHeader({ phase: "ready" }, longModelId, { checkCount: 0, rejectionCount: 0 });
	h.publisher.updateHeader({ phase: "ready" }, longModelId, { checkCount: 0, rejectionCount: 0 });
	expect(h.headers).toHaveLength(1);
	expect(h.headers[0]?.modelId).toHaveLength(240);
});

it("publishes changed review totals even when status is unchanged and replays the latest totals", () => {
	const h = harness();
	h.publisher.updateHeader({ phase: "checking" }, "provider/model", { checkCount: 1, rejectionCount: 0 });
	h.publisher.updateHeader({ phase: "checking" }, "provider/model", { checkCount: 1, rejectionCount: 0 });
	h.publisher.updateHeader({ phase: "checking" }, "provider/model", { checkCount: 2, rejectionCount: 0 });
	h.publisher.updateHeader({ phase: "checking" }, "provider/model", { checkCount: 2, rejectionCount: 1 });
	expect(h.headers.map(({ checkCount, rejectionCount }) => ({ checkCount, rejectionCount }))).toEqual([
		{ checkCount: 1, rejectionCount: 0 },
		{ checkCount: 2, rejectionCount: 0 },
		{ checkCount: 2, rejectionCount: 1 },
	]);
	const latestHeader = h.headers.at(-1);
	h.headers.length = 0;
	h.events.emit(QUALITY_ACTIVITY_DISCOVER_CHANNEL, { version: 1, sessionId: "session-a" });
	expect(h.headers).toEqual([latestHeader]);
	h.publisher.reset("session-b");
	h.publisher.updateHeader({ phase: "ready" }, "provider/model", { checkCount: 0, rejectionCount: 0 });
	expect(h.headers.at(-1)).toMatchObject({ sessionId: "session-b", checkCount: 0, rejectionCount: 0 });
});

it("later header changes do not rewrite completed call history", () => {
	const h = harness();
	h.publisher.begin("edit-a");
	h.publisher.finishCollection();
	h.publisher.update({ phase: "approved" });
	h.received.length = 0;
	h.publisher.updateHeader({ phase: "disabled" }, "provider/model", { checkCount: 1, rejectionCount: 0 });
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
