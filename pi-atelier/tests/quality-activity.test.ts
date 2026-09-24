import { expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	parseQualityActivity,
	parseQualityHeader,
	type QualityActivityPhase,
} from "../src/quality-activity.js";
import { createRunActivityTracker } from "../src/run-activity.js";
import { createInertAtelierState } from "../src/state.js";
import { buildSidebarSnapshot, renderActivityLines } from "../src/sidebar.js";

it("validates event identities, phases, revisions and counters without retaining extra content", () => {
	const event = {
		version: 1,
		sessionId: "session",
		toolCallId: "edit-a",
		phase: "checking",
		revision: 2,
		reviewAttempt: 1,
	};
	expect(parseQualityActivity({ ...event, sourceCode: "not presentation data" })).toEqual({
		sessionId: "session",
		toolCallId: "edit-a",
		phase: "checking",
		revision: 2,
		reviewAttempt: 1,
	});
	for (const patch of [
		{ version: 2 },
		{ sessionId: "" },
		{ toolCallId: "a\u001b[31m" },
		{ phase: "__proto__" },
		{ revision: -1 },
		{ revision: NaN },
		{ reviewAttempt: 6 },
		{ correctionAttempt: 1 },
		{ correctionAttempt: 6, correctionLimit: 5 },
	])
		expect(parseQualityActivity({ ...event, ...patch })).toBeUndefined();
});

it("validates standalone header data without requiring a tool call", () => {
	const header = { version: 1, sessionId: "session", phase: "ready", revision: 1, modelId: "test/reviewer" };
	expect(parseQualityHeader(header)).toEqual({
		sessionId: "session",
		phase: "ready",
		revision: 1,
		modelId: "test/reviewer",
	});
	expect(parseQualityHeader({ ...header, modelId: "x".repeat(241) })).toBeUndefined();
	expect(parseQualityHeader({ ...header, modelId: "bad\u001b[31m" })).toBeUndefined();
	expect(parseQualityActivity(header)).toBeUndefined();
});

it("places the Quality header immediately below auto and above the activity track", () => {
	const snapshot = buildSidebarSnapshot({
		state: createInertAtelierState(null),
		cwd: "/repo",
		branchEntryCount: 0,
		extensionStatuses: [],
		autoModeState: { enabled: true, usable: true, modelId: "test/auto", allowed: 0, asked: 0 },
		qualityHeader: { sessionId: "session", phase: "ready", revision: 1, modelId: "test/reviewer" },
	});
	const theme = {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
	const lines = renderActivityLines(snapshot, theme, 44, 12, false, 100);
	expect(lines[0]).toContain("auto");
	expect(lines[1]).toContain("󰅴 quality · test/reviewer");
	expect(lines[1]).not.toContain("ready");
	expect(lines[2]).toContain("╭");
	for (const width of [8, 28, 44]) {
		const renderedLines = renderActivityLines(snapshot, theme, width, 12, false, 100);
		for (const line of renderedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	}
});

it.each(["checking", "approved", "needs_work", "user_approved", "disabled"] as const)(
	"keeps %s status out of the identity-only header",
	(phase) => {
		const snapshot = buildSidebarSnapshot({
			state: createInertAtelierState(null),
			cwd: "/repo",
			branchEntryCount: 0,
			extensionStatuses: [],
			qualityHeader: { sessionId: "session", phase, revision: 1, modelId: "test/reviewer" },
		});
		const theme = {
			fg: (_role: string, text: string) => text,
			bold: (text: string) => text,
			italic: (text: string) => text,
		};
		const header = renderActivityLines(snapshot, theme, 44, 12, false, 100)[0]!;
		expect(header.slice(2).trim()).toBe("󰅴 quality · test/reviewer");
	},
);

it("attaches early and late events by call ID and keeps snapshots immutable", () => {
	const tracker = createRunActivityTracker({ cwd: "/repo" });
	tracker.recordQuality("edit-a", { phase: "pending", revision: 1 });
	tracker.startTool(
		{ type: "tool_execution_start", toolCallId: "edit-a", toolName: "edit", args: { path: "a.ts" } },
		0,
	);
	const prior = tracker.getSnapshot();
	tracker.finishTool(
		{ type: "tool_execution_end", toolCallId: "edit-a", toolName: "edit", result: {}, isError: false },
		1,
	);
	tracker.recordQuality("edit-a", { phase: "approved", revision: 3 });
	tracker.recordQuality("edit-a", { phase: "checking", revision: 2 });
	expect(prior.activeTools[0]?.quality?.phase).toBe("pending");
	expect(tracker.getSnapshot().recentTools[0]?.quality?.phase).toBe("approved");
	expect(Object.isFrozen(tracker.getSnapshot().recentTools[0]?.quality)).toBe(true);
	tracker.startRun(2);
	expect(tracker.getSnapshot().recentTools[0]?.quality?.phase).toBe("approved");
	tracker.clearQuality();
	expect(tracker.getSnapshot().recentTools[0]?.quality).toBeUndefined();
});

it("renders the review inline and preserves tool failure independently", () => {
	const tracker = createRunActivityTracker({ cwd: "/repo" });
	tracker.startTool(
		{ type: "tool_execution_start", toolCallId: "edit-a", toolName: "edit", args: { path: "a.ts" } },
		0,
	);
	tracker.finishTool(
		{ type: "tool_execution_end", toolCallId: "edit-a", toolName: "edit", result: {}, isError: true },
		100,
	);
	tracker.recordQuality("edit-a", {
		phase: "needs_work",
		revision: 1,
		correctionAttempt: 1,
		correctionLimit: 5,
	});
	const snapshot = buildSidebarSnapshot({
		state: createInertAtelierState(null),
		cwd: "/repo",
		branchEntryCount: 0,
		extensionStatuses: [],
		runActivity: tracker.getSnapshot(),
	});
	const theme = {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
	const lines = renderActivityLines(snapshot, theme, 44, 12, false, 100);
	const callIndex = lines.findIndex((line) => line.includes("a.ts"));
	expect(callIndex).toBeGreaterThanOrEqual(0);
	expect(lines[callIndex]).toContain("failed");
	expect(lines[callIndex]).toContain("󰅴 ✕");
	expect(lines[callIndex + 1]?.trim()).toBe("│");
	expect(lines.join("\n")).not.toContain("Quality ·");
	for (const width of [8, 28, 44]) {
		const renderedLines = renderActivityLines(snapshot, theme, width, 12, false, 100);
		for (const line of renderedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	}
});

function renderQualityCall(phase: QualityActivityPhase, width = 44, colorEnabled = false): string[] {
	const tracker = createRunActivityTracker({ cwd: "/repo" });
	tracker.startTool(
		{ type: "tool_execution_start", toolCallId: "edit-a", toolName: "edit", args: { path: "a.ts" } },
		0,
	);
	tracker.recordPermission({
		requestId: "permission-a",
		toolCallId: "edit-a",
		surface: "edit",
		value: "a.ts",
		source: "auto",
		state: "allow",
		at: 1,
	});
	tracker.finishTool(
		{ type: "tool_execution_end", toolCallId: "edit-a", toolName: "edit", result: {}, isError: false },
		100,
	);
	tracker.recordQuality("edit-a", { phase, revision: 1 });
	const snapshot = buildSidebarSnapshot({
		state: createInertAtelierState(null),
		cwd: "/repo",
		branchEntryCount: 0,
		extensionStatuses: [],
		runActivity: tracker.getSnapshot(),
	});
	const theme = {
		name: "dark",
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
	return renderActivityLines(snapshot, theme, width, 12, colorEnabled, 100);
}

it.each([28, 44])("keeps classifier and quality badges on the same tool row at %s columns", (width) => {
	const lines = renderQualityCall("approved", width);
	const row = lines.find((line) => line.startsWith("│ edit"))!;
	const plainRow = row.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
	if (width === 28) {
		expect(plainRow).toBe("│ edit a.  󰚩 ✓  󰅴 ✓ done <1s");
	} else {
		expect(plainRow).toMatch(/^│ edit a\.ts\s+󰚩 ✓  󰅴 ✓ done <1s$/);
	}
	expect(lines.filter((line) => line.includes("󰅴"))).toHaveLength(1);
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
});

it.each([
	{ phase: "approved", symbol: "✓", color: "177;140;255" },
	{ phase: "user_approved", symbol: "✓", color: "125;211;252" },
	{ phase: "needs_work", symbol: "✕", color: "255;93;115" },
	{ phase: "blocked", symbol: "✕", color: "255;93;115" },
	{ phase: "checking", symbol: "?", color: "255;159;67" },
	{ phase: "pending", symbol: "?", color: "255;159;67" },
	{ phase: "awaiting_user", symbol: "?", color: "255;159;67" },
	{ phase: "applying", symbol: "?", color: "255;159;67" },
	{ phase: "paused", symbol: "?", color: "255;159;67" },
	{ phase: "unconfigured", symbol: "?", color: "255;159;67" },
] as const)("uses classifier colors for the $phase quality badge", ({ phase, symbol, color }) => {
	const rows = renderQualityCall(phase, 44, true);
	const call = rows.find((row) => row.includes("a.ts"))!;
	const plain = call.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
	expect(plain).toContain(`󰅴 ${symbol}`);
	expect(call).toContain(`\u001b[38;2;${color}m${symbol}\u001b[39m`);
	const iconColor = phase === "user_approved" ? "125;211;252" : "177;140;255";
	expect(call).toContain(`\u001b[38;2;${iconColor}m󰅴\u001b[39m`);
});

it.each(["ready", "excluded", "waived", "unchanged", "not_reviewed", "disabled"] as const)(
	"does not imply approval for %s",
	(phase) => {
		const rows = renderQualityCall(phase, 44, true);
		const call = rows.find((row) => row.includes("a.ts"))!;
		expect(call).toContain("\u001b[38;2;102;102;102m󰅴 –\u001b[39m");
	},
);
