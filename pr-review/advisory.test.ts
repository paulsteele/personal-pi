import { expect, it } from "vitest";
import { checkAdvisory } from "./findings.js";
import { seeds, interpretDecision } from "./plannotator.js";
import { renderReport } from "./report.js";
import type { Advisory, Report } from "./types.js";
import type { Snapshot } from "./snapshot.js";
const advisory: Advisory = {
	id: "A1",
	title: "Shared lifecycle",
	files: ["a.ts"],
	concern: "Ownership is implicit",
	recommendation: "Document the contract",
	tradeoffs: "More explicit API",
	evidence: [{ file: "a.ts", side: "new", line: 1, quote: "export const x = 1;" }],
};
const snapshot = {
	changes: [{ file: "a.ts", oldPath: "a.ts" }],
	read: async () => Buffer.from("export const x = 1;\n"),
} as unknown as Snapshot;
const report = {
	id: "run",
	project: "p",
	scope: { kind: "local" },
	status: "complete",
	changedFiles: 1,
	fingerprint: "abc",
	model: "test",
	baseline: null,
	head: null,
	lenses: [],
	omitted: [],
	issues: [],
	findings: [],
	groups: [],
	ledger: [],
	clean: [],
	declined: [],
	elapsedMs: 0,
	usage: { input: 0, output: 0, cost: 0 },
	advisories: [advisory],
} as unknown as Report;
it("validates advisory evidence without promoting design judgments to defects", async () => {
	await checkAdvisory(advisory, snapshot);
	await expect(
		checkAdvisory({ ...advisory, evidence: [{ ...advisory.evidence[0]!, quote: "invented" }] }, snapshot),
	).rejects.toThrow("quote");
	await expect(checkAdvisory({ ...advisory, files: ["unrelated.ts"] }, snapshot)).rejects.toThrow("changed");
	expect(renderReport(report)).toContain("UNVERIFIED DESIGN ADVISORY");
});
it("never authorizes an advisory even when submitted, edited, or replied to", () => {
	const items = seeds(report, snapshot),
		ids = items.map((_, i) => `u${i}`);
	const annotations = items.map((item, i) => ({ ...item.annotation, id: ids[i]! }));
	expect(items.every((item) => item.findingIds.length === 0)).toBe(true);
	for (const variants of [
		annotations,
		annotations.map((item) => ({ ...item, text: "please discuss" })),
		[...annotations, { id: "reply", inReplyTo: ids.at(-1), text: "why?" }],
	]) {
		expect(
			interpretDecision({ approved: false, feedback: "", annotations: variants }, items, ids).requestedIds,
		).toEqual([]);
	}
});
