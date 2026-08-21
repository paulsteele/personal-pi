import { describe, expect, test } from "bun:test";
import {
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
