import { expect, it } from "vitest";
import { jsonBytes, packReviewInputs, packVerificationInputs, prepareChanges } from "./batching.js";
import type { Change, Snapshot } from "./snapshot.js";
import type { Candidate, Lens } from "./types.js";
const signal = () => new AbortController().signal;
const lens: Lens = {
	id: "security",
	name: "Security",
	focus: "Fixture",
	reading: ["rules.md"],
	reason: "fixture",
};
const change = (file: string, patch = "diff"): Change => ({
	file,
	oldPath: file,
	patch,
	added: [],
	removed: [],
	oldLines: new Set(),
	newLines: new Set(),
	metadataOnly: false,
});
const candidate = (id: string, file = "a.ts"): Candidate => ({
	id,
	file,
	reviewer: "Security",
	side: "new",
	startLine: 1,
	endLine: 1,
	title: id,
	severity: "medium",
	problem: "problem",
	suggestion: "fix",
	rationale: "why",
	evidence: [{ file, side: "new", line: 1, quote: "x" }],
});
it("packs related findings across files, preserves metadata and document references", async () => {
	const candidates = [candidate("F1"), candidate("F2", "b.ts")];
	const snapshot = { changes: [change("a.ts"), { ...change("b.ts"), metadataOnly: true }] } as Snapshot;
	const packed = await packVerificationInputs({
		project: "p",
		candidates,
		lenses: [lens],
		snapshot,
		system: "v",
		maxBytes: 16000,
		maxJobs: 1,
		signal: signal(),
	});
	expect(packed.batches).toHaveLength(1);
	expect(packed.batches[0]!.input.changes.map((c) => c.file)).toEqual(["a.ts", "b.ts"]);
	expect(packed.batches[0]!.input.changes[1]!.metadataOnly).toBe(true);
	expect(packed.batches[0]!.input.requiredReading).toEqual(["rules.md"]);
});
it("treats ten candidates as a per-batch bound, never a total job quota", async () => {
	const candidates = Array.from({ length: 1301 }, (_, i) => candidate(`F${i}`));
	const packed = await packVerificationInputs({
		project: "p",
		candidates,
		lenses: [lens],
		snapshot: { changes: [change("a.ts")] } as Snapshot,
		system: "v",
		maxBytes: 16000,
		maxJobs: 1,
		signal: signal(),
	});
	expect(packed.batches).toHaveLength(131);
	expect(packed.batches.flatMap((b) => b.candidates)).toEqual(candidates);
	expect(packed.rejected).toEqual([]);
	for (const batch of packed.batches) {
		expect(batch.candidates.length).toBeLessThanOrEqual(10);
		expect(jsonBytes(batch.input)).toBeLessThan(16000);
	}
});
it("pages oversized candidates instead of rejecting them", async () => {
	const huge = { ...candidate("huge"), problem: "x".repeat(100000) };
	const packed = await packVerificationInputs({
		project: "p",
		candidates: [huge],
		lenses: [lens],
		snapshot: { changes: [change("a.ts")] } as Snapshot,
		system: "v",
		maxBytes: 16000,
		signal: signal(),
	});
	expect(packed.rejected).toEqual([]);
	expect(packed.batches[0]!.input.candidates).toEqual([]);
	expect(packed.batches[0]!.input.candidateIds).toEqual(["huge"]);
	expect(packed.batches[0]!.candidates).toEqual([huge]);
});
it("retains every patch reference despite tiny old job/input quotas and honours abort", async () => {
	const parts = await prepareChanges([change("large", "x".repeat(20000)), change("small", "δ\n")], signal());
	const packed = await packReviewInputs({ project: "p", lens, requiredDocuments: {} }, parts, {
		system: "s",
		maxBytes: 1000,
		maxJobs: 0,
		signal: signal(),
	});
	expect(packed.omitted).toEqual([]);
	expect(packed.inputs.flatMap((i) => i.changes).map((c) => c.file)).toEqual(["large", "small"]);
	await expect(prepareChanges([change("a")], AbortSignal.abort())).rejects.toThrow();
});
