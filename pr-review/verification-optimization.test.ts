import type { Model, Api } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import type { Snapshot } from "./snapshot.js";
import { deduplicateCandidates, needsSemanticConsolidation, validateGroups } from "./findings.js";
import { packVerificationInputs } from "./batching.js";
import type { Candidate } from "./types.js";

const finding: Candidate = {
	id: "F1",
	reviewer: "Security",
	title: "Changed default",
	severity: "medium",
	file: "a.ts",
	side: "new",
	startLine: 1,
	endLine: 1,
	problem: "Fixture defect",
	suggestion: "Preserve the default",
	rationale: "Fixture contract",
	evidence: [{ file: "a.ts", side: "new", line: 1, quote: "export const enabled = true;" }],
};

it("deduplicates only the complete exact claim, independent of object key order", () => {
	const { id: _, reviewer: _reviewer, ...body } = finding;
	const reordered = Object.fromEntries(Object.entries(body).reverse());
	const same = { ...reordered, id: "F2", reviewer: "Correctness" } as Candidate;
	const distinct = [
		{ ...finding, id: "F3", title: "Different title" },
		{ ...finding, id: "F4", severity: "high" as const },
		{ ...finding, id: "F5", problem: finding.problem + " " },
		{ ...finding, id: "F6", rationale: "Different rationale" },
		{ ...finding, id: "F7", evidence: [{ ...finding.evidence[0]!, line: 2 }] },
	];
	const result = deduplicateCandidates([finding, same, ...distinct]);
	expect(result.candidates.map((c) => c.id)).toEqual(["F1", "F3", "F4", "F5", "F6", "F7"]);
	expect(result.members.get("F1")).toEqual([finding, same]);
});

it("skips consolidation only when distinct exact groups cannot legally merge", () => {
	const same = { ...finding, id: "F2", reviewer: "Correctness" };
	expect(needsSemanticConsolidation([finding, same])).toBe(false);
	for (const other of [
		{ ...same, file: "b.ts" },
		{ ...same, side: "old" as const },
		{ ...same, startLine: 2, endLine: 3 },
	]) {
		expect(needsSemanticConsolidation([finding, other])).toBe(false);
		expect(() => validateGroups([["F1", "F2"]], [finding, other])).toThrow();
	}
	expect(
		needsSemanticConsolidation([finding, { ...same, problem: "Distinct claim at the same location" }]),
	).toBe(true);
});

it("packs verification by model context while retaining ten-claim and paging boundaries", async () => {
	const candidates = Array.from({ length: 11 }, (_, i) => ({
		...finding,
		id: `F${i}`,
		problem: "x".repeat(20000),
	}));
	const snapshot = { changes: [{ file: "a.ts", oldPath: "a.ts", metadataOnly: false }] } as Snapshot;
	const options = {
		project: "p",
		candidates,
		lenses: [],
		snapshot,
		system: "Policy",
		signal: new AbortController().signal,
	};
	const model = { contextWindow: 200000, maxTokens: 8192 } as Model<Api>;
	const large = await packVerificationInputs({ ...options, model });
	expect(large.batches.map((b) => b.candidates.length)).toEqual([10, 1]);
	expect(JSON.stringify(large.batches[0]!.input).length).toBeGreaterThan(64000);
	const small = await packVerificationInputs({ ...options, model: { ...model, contextWindow: 12000 } });
	expect(small.batches.length).toBeGreaterThan(large.batches.length);
	expect(small.batches.flatMap((b) => b.candidates)).toEqual(candidates);
	const tiny = await packVerificationInputs({ ...options, model: { ...model, contextWindow: 4000 } });
	expect(tiny.batches.every((b) => b.input.candidates.length === 0)).toBe(true);
	expect(tiny.rejected).toEqual([]);
});
