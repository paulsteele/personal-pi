import { expect, it } from "vitest";
import {
	actionPayload,
	displayOutcome,
	fitsResult,
	hasDiscussionFeedback,
	reviewOutcome,
} from "./handoff.js";
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
	expect(result.endsWith("Audit report (optional): /private/full-report.json")).toBe(true);
	expect(Buffer.byteLength(result)).toBeLessThanOrEqual(50 * 1024);
});

it("supplies selected evidence inline without requiring a filesystem read", () => {
	const value = report({ decision: "feedback", requestedIds: ["F1"], discussion: [], feedback: "" });
	value.findings[0]!.evidence = [{ file: "a.ts", side: "new", line: 1, quote: "const fixture = true;" }];
	const result = reviewOutcome(value, "/private/report.json", "Respect the human gate.");
	expect(result.actionComplete).toBe(true);
	expect(result.handoff).toBe(true);
	expect(result.text).toContain('"actionComplete":true');
	expect(result.text).toContain('"quote":"const fixture = true;"');
	expect(result.text).toContain("no report retrieval is required");
	expect(displayOutcome(result)).toBe(result.text);
	expect(fitsResult(result.text)).toBe(true);
});

it("retains a non-primary requested group ID without authorizing other members", () => {
	const value = report({ decision: "feedback", requestedIds: ["F2"], discussion: [], feedback: "" });
	value.findings.push({ ...value.findings[0]!, id: "F2", reviewer: "Correctness" });
	value.groups = [["F1", "F2"]];
	const action = actionPayload(value);
	expect(action.browser.requestedIds).toEqual(["F2"]);
	expect(action.findings.map((finding) => finding.id)).toEqual(["F2"]);
	expect(action.groups).toEqual([["F1", "F2"]]);
});

it("includes unselected findings and advisory context for discussion without granting fixes", () => {
	const discussion = [
		{
			id: "reply",
			inReplyTo: "annotation",
			text: "Explain A1 and F1 first.",
			filePath: "a.ts",
			lineStart: 1,
		},
	];
	const value = report({ decision: "lgtm", requestedIds: [], discussion, feedback: "Please explain these." });
	value.advisories = [
		{
			id: "A1",
			title: "Alternative design",
			files: ["a.ts"],
			concern: "Coupling",
			recommendation: "Separate concerns",
			tradeoffs: "More types",
			evidence: [],
		},
	];
	const action = actionPayload(value);
	expect(action.browser.requestedIds).toEqual([]);
	expect(action.browser.discussion).toEqual(discussion);
	expect(action.findings.map((finding) => finding.id)).toEqual(["F1"]);
	expect(action.advisories.map((advisory) => advisory.id)).toEqual(["A1"]);
	expect(action.advisoryAuthorization).toContain("no fixes authorized");
});

it("redacts nested human discussion, evidence, and feedback consistently", () => {
	const token = "ghp_" + "x".repeat(32);
	const value = report({
		decision: "feedback",
		requestedIds: ["F1"],
		discussion: [{ text: token, nested: { text: token } }],
		feedback: token,
	});
	value.findings[0]!.evidence = [{ file: "a.ts", line: 1, side: "new", quote: token }];
	const action = actionPayload(value);
	expect(JSON.stringify(action)).not.toContain(token);
	expect(action.browser.feedback).toBe("[redacted]");
	expect(action.browser.discussion).toEqual([{ text: "[redacted]", nested: { text: "[redacted]" } }]);
	expect(action.findings[0]!.evidence[0]!.quote).toBe("[redacted]");
});

it("keeps complete human feedback ahead of huge optional diagnostics and summary", () => {
	const value = report({ decision: "lgtm", requestedIds: [], discussion: [], feedback: "Explain F1." });
	value.ledger = Array.from({ length: 10000 }, (_, index) => ({
		id: `V${index}`,
		verdict: "dropped",
		reason: "diagnostic".repeat(100),
	}));
	const complete = reviewOutcome(value, "/private/report.json", "Respect the human gate.");
	expect(complete.actionComplete).toBe(true);
	expect(complete.text).toContain('"feedback":"Explain F1."');
	expect(complete.text).not.toContain("diagnosticdiagnostic");
	expect(fitsResult(complete.text)).toBe(true);
});

it.each(["feedback", "discussion", "finding", "ids"])(
	"routes oversized %s to scoped action retrieval",
	(resource) => {
		const value = report({ decision: "feedback", requestedIds: ["F1"], discussion: [], feedback: "" });
		const largeText = '😀\\"\\n'.repeat(20000);
		if (resource === "feedback") {
			value.browser!.feedback = largeText;
		} else if (resource === "discussion") {
			value.browser!.discussion = [{ id: "reply", text: largeText }];
		} else if (resource === "finding") {
			value.findings[0]!.suggestion = largeText;
		} else {
			value.browser!.requestedIds = Array.from({ length: 20000 }, (_, index) => `F${index}`);
		}
		const result = reviewOutcome(value, "/private/report.json", "Respect the human gate.");
		expect(result.actionComplete).toBe(false);
		expect(result.text).toContain('"actionComplete":false');
		expect(result.text).toContain('"section":"action","cursor":0');
		expect(result.text).toContain("follow nextOffset until null");
		expect(fitsResult(result.text)).toBe(true);
		expect(displayOutcome(result)).toBe(result.text);
	},
);

it("optional summary truncation does not change complete no-fix action data", () => {
	const value = report({ decision: "lgtm", requestedIds: [], discussion: [], feedback: "" });
	value.findings = Array.from({ length: 5000 }, (_, index) => ({ ...value.findings[0]!, id: `F${index}` }));
	const result = reviewOutcome(value, "/private/report.json", "Respect the human gate.");
	expect(result.actionComplete).toBe(true);
	expect(result.text).toContain("Optional summary truncated");
	expect(result.text).toContain("NO FIXES AUTHORIZED");
	expect(fitsResult(result.text)).toBe(true);
});
