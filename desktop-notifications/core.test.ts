import { describe, expect, test } from "bun:test";
import {
	askUserNotification,
	createQualityAttentionTracker,
	decodeArgument,
	encodeArgument,
	isHyprlandAddress,
	isMacWindowId,
	latestFinalAssistantText,
	normalizeNotificationText,
	notificationPreview,
	replacementKey,
	safeProjectLabel,
	truncateUnicode,
} from "./core.ts";

describe("assistant extraction", () => {
	test("returns only the newest successful assistant text", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old" }] } },
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool" }] } },
			{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "new" }] } },
		];
		expect(latestFinalAssistantText(entries)).toBe("new");
	});

	test("skips tool-only, aborted, pending, and error messages", () => {
		for (const stopReason of ["toolUse", "aborted", "pending", "error"]) {
			expect(latestFinalAssistantText([
				{ type: "message", message: { role: "assistant", stopReason, content: [{ type: "text", text: "nope" }] } },
			])).toBe("");
		}
		expect(latestFinalAssistantText([
			{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "toolCall" }] } },
		])).toBe("");
	});
});

describe("notification text", () => {
	test("builds ask-user notification text", () => {
		expect(askUserNotification({ questions: [{ question: "Which database?" }] })).toEqual({
			subtitle: "Question needs your input",
			body: "Which database?",
		});
		expect(
			askUserNotification({ questions: [{ question: "First?" }, { question: "Second?" }, { question: "Third?" }] }),
		).toEqual({ subtitle: "3 questions need your input", body: "First? (+2 more)" });
		expect(askUserNotification({ questions: [] })).toBeUndefined();
		expect(askUserNotification({ questions: [{ question: 42 }] })).toBeUndefined();
	});

	test("strips markdown, ANSI, controls, and folds whitespace", () => {
		const input = "\u001b[31m## **Done**\u001b[0m\n- See [result](https://example.test) and `code`\u0000";
		expect(normalizeNotificationText(input)).toBe("Done See result and code");
	});

	test("truncates Unicode by code point", () => {
		expect(truncateUnicode("ab😀cd", 4)).toBe("ab😀…");
		expect(notificationPreview("", 20)).toBe("Ready for input");
	});

	test("creates a bounded safe project label", () => {
		expect(safeProjectLabel("/tmp/my\nproject/")).toBe("my project");
		expect(Array.from(safeProjectLabel(`/tmp/${"x".repeat(100)}`)).length).toBe(64);
	});
});

describe("quality attention", () => {
	const request = { version: 1, sessionId: "session", requestId: "request-a", kind: "arbitration", active: true };

	test.each(["arbitration", "coverage", "failure", "scope", "model", "waiver"])("shows and clears a %s decision without exposing source data", (kind) => {
		const tracker = createQualityAttentionTracker("session");
		const event = { ...request, kind, findings: "PRIVATE_SOURCE", reason: "SECRET" };
		const result = tracker.update(event);
		expect(result).toMatchObject({ action: "show", notification: { subtitle: expect.stringContaining("Quality") } });
		expect(JSON.stringify(result)).not.toContain("PRIVATE_SOURCE");
		expect(JSON.stringify(result)).not.toContain("SECRET");
		expect(tracker.active).toBe(true);
		expect(tracker.update(event)).toBeUndefined();
		expect(tracker.update({ ...event, active: false })).toEqual({ action: "clear" });
		expect(tracker.active).toBe(false);
		expect(tracker.update({ ...event, active: false })).toBeUndefined();
	});

	test("rejects stale sessions, malformed events, and agent-owned quality phases", () => {
		const tracker = createQualityAttentionTracker("session");
		const rejectedEvents = {
			nullPayload: null,
			missingFields: {},
			unknownVersion: { ...request, version: 2 },
			retiredSession: { ...request, sessionId: "old" },
			nonStringRequestId: { ...request, requestId: 42 },
			nonBooleanActive: { ...request, active: "true" },
			prototypeKey: { ...request, kind: "__proto__" },
			agentCorrection: { ...request, kind: "needs_work" },
			inFlightReview: { ...request, kind: "checking" },
		};
		for (const [scenario, event] of Object.entries(rejectedEvents)) {
			expect(tracker.update(event), scenario).toBeUndefined();
		}
		expect(tracker.active).toBe(false);
	});

	test("finishing an older decision cannot clear the latest decision notice", () => {
		const tracker = createQualityAttentionTracker("session");
		tracker.update(request);
		tracker.update({ ...request, requestId: "request-b", kind: "coverage" });
		expect(tracker.update({ ...request, active: false })).toBeUndefined();
		expect(tracker.active).toBe(true);
		expect(tracker.update({ ...request, requestId: "request-b", kind: "coverage", active: false })).toEqual({ action: "clear" });
	});

	test("restores a remaining decision when the newest one closes", () => {
		const tracker = createQualityAttentionTracker("session");
		const initial = tracker.update(request);
		tracker.update({ ...request, requestId: "request-b", kind: "scope" });
		expect(tracker.update({ ...request, requestId: "request-b", kind: "scope", active: false })).toEqual(initial);
		expect(tracker.active).toBe(true);
	});
});

describe("transport and identifiers", () => {
	test("round trips UTF-8 base64 and rejects malformed input", () => {
		const encoded = encodeArgument("hello 😀 ' \n");
		expect(decodeArgument(encoded)).toBe("hello 😀 ' \n");
		expect(decodeArgument("not base64!")) .toBeUndefined();
	});

	test("validates native identifiers and keys", () => {
		expect(isMacWindowId(4226)).toBe(true);
		expect(isMacWindowId(-1)).toBe(false);
		expect(isMacWindowId("4226")).toBe(false);
		expect(isHyprlandAddress("0x1aB2")).toBe(true);
		expect(isHyprlandAddress("1aB2;rm -rf /")).toBe(false);
		expect(replacementKey("mac", 4226)).toBe("pi-mac-4226");
		expect(replacementKey("hyprland", "0x1aB2")).toBe("pi-hyprland-1ab2");
		expect(() => replacementKey("hyprland", "bad")).toThrow();
	});
});
