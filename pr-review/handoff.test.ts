import { expect, it } from "vitest";
import { displayOutcome, hasDiscussionFeedback, reviewOutcome } from "./handoff.js";
import type { Report } from "./types.js";
function report(browser?: Report["browser"]): Report {
	return {
		version: 1,
		id: "fixture",
		repoId: "fixture",
		project: "Fixture",
		createdAt: "now",
		scope: { kind: "local" },
		baseline: null,
		head: null,
		fingerprint: "snapshot",
		profileHash: "profile",
		promptHashes: {},
		model: "fake",
		status: "incomplete",
		lenses: [],
		declined: [],
		clean: [],
		issues: [],
		omitted: [],
		changedFiles: 1,
		findings: [
			{
				id: "F1",
				reviewer: "Security",
				title: "Fixture finding",
				severity: "medium",
				file: "a.ts",
				side: "new",
				startLine: 1,
				endLine: 1,
				problem: "Fixture",
				suggestion: "Proposed change",
				rationale: "Fixture",
				evidence: [],
			},
		],
		groups: [["F1"]],
		ledger: [],
		elapsedMs: 0,
		usage: { input: 0, output: 0, cost: 0 },
		...(browser ? { browser } : {}),
	};
}
it.each(["lgtm", "dismissed", "unavailable"])(
	"keeps an explicit no-fix decision in %s results even with findings",
	(decision) => {
		const value = report(
			decision === "unavailable" ? undefined : { decision, requestedIds: [], discussion: [], feedback: "" },
		);
		const result = reviewOutcome(value, "/private/report.json", "Respect the human gate.");
		expect(result.text.indexOf("NO FIXES AUTHORIZED")).toBeLessThan(result.text.indexOf("Fixture finding"));
		expect(result.text).toContain("Requested verified finding IDs: []");
		expect(result.handoff).toBe(false);
	},
);
it("routes approval notes to discussion without granting fixes", () => {
	const result = reviewOutcome(
		report({
			decision: "lgtm",
			requestedIds: [],
			discussion: [],
			feedback: "Please explain F1 before changing anything.",
		}),
		"/private/report.json",
		"Respect notes.",
	);
	expect(result.handoff).toBe(true);
	expect(result.text).toContain("NO FIXES AUTHORIZED");
	expect(result.text).toContain("browser.feedback");
	expect(hasDiscussionFeedback("LGTM - no changes requested.")).toBe(false);
	expect(hasDiscussionFeedback("LGTM — but explain the issue")).toBe(true);
});
it("retains the full report locator and truncation notice on long command/tool displays", () => {
	const result = displayOutcome({
		text: "NO FIXES AUTHORIZED\n" + "long report\n".repeat(10000),
		path: "/private/full-report.json",
	});
	expect(result).toContain("NO FIXES AUTHORIZED");
	expect(result).toContain("Display truncated");
	expect(result.endsWith("Full structured report: /private/full-report.json")).toBe(true);
	expect(Buffer.byteLength(result)).toBeLessThanOrEqual(50 * 1024);
});
