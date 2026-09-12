import { expect, it, vi } from "vitest";
import { jsonBytes, packReviewInputs, packVerificationInputs, prepareChanges } from "./batching.js";
import type { Change, Snapshot } from "./snapshot.js";
import type { Candidate, Lens } from "./types.js";
const lens: Lens = {
	id: "security",
	name: "Security",
	focus: "Fixture",
	reading: ["rules.md"],
	reason: "fixture",
};
const signal = () => new AbortController().signal;
const change = (file: string, patch: string): Change => ({
	file,
	oldPath: file,
	patch,
	added: [],
	removed: [],
	oldLines: new Set(),
	newLines: new Set(),
	metadataOnly: false,
});
const candidate = (id: string): Candidate => ({
	id,
	reviewer: "Security",
	file: "a.ts",
	side: "new",
	startLine: 1,
	endLine: 1,
	title: id,
	severity: "medium",
	problem: "p".repeat(4000),
	suggestion: "s".repeat(4000),
	rationale: "fixture",
	evidence: [{ file: "a.ts", side: "new", line: 1, quote: "x" }],
});
it("measures fixed reviewer context once and packs exact UTF-8/escaped JSON byte sizes", async () => {
	let measured = 0;
	const requiredDocuments = {
		get "rules.md"() {
			measured++;
			return "δ\\\n".repeat(1000);
		},
	};
	const parts = await prepareChanges(
		Array.from({ length: 200 }, (_, i) => change(`${i}.ts`, 'λ\n"'.repeat(100))),
		signal(),
	);
	const packed = await packReviewInputs({ project: "Project", lens, requiredDocuments }, parts, {
		system: "system",
		maxBytes: 12000,
		maxJobs: 100,
		signal: signal(),
	});
	expect(measured).toBe(1);
	expect(packed.omitted).toEqual([]);
	expect(packed.inputs.flatMap((input) => input.changes)).toHaveLength(200);
	for (const input of packed.inputs)
		expect(jsonBytes(input) + Buffer.byteLength("system")).toBeLessThanOrEqual(12000);
});
it("enforces reviewer job caps while packing and honours cancellation", async () => {
	const parts = await prepareChanges(
		Array.from({ length: 50 }, (_, i) => change(`${i}.ts`, "x".repeat(1000))),
		signal(),
	);
	await expect(
		packReviewInputs({ project: "p", lens, requiredDocuments: {} }, parts, {
			system: "s",
			maxBytes: 1600,
			maxJobs: 2,
			signal: signal(),
		}),
	).rejects.toThrow("more jobs");
	await expect(prepareChanges([change("a", "diff")], AbortSignal.abort())).rejects.toThrow();
});
it("splits verifiers by bytes and document union without rejecting independently fitting candidates", async () => {
	const read = vi.fn(async () => Buffer.from("rules\n".repeat(1600)));
	const snapshot = { changes: [change("a.ts", "diff")], read } as unknown as Snapshot;
	const candidates = Array.from({ length: 10 }, (_, i) => candidate(`F${i}`));
	const packed = await packVerificationInputs({
		project: "Project",
		candidates,
		lenses: [lens],
		snapshot,
		system: "verifier",
		maxBytes: 24000,
		maxJobs: 20,
		signal: signal(),
	});
	expect(packed.batches.length).toBeGreaterThan(1);
	expect(packed.rejected).toEqual([]);
	expect(packed.batches.flatMap((batch) => batch.candidates).map((item) => item.id)).toEqual(
		candidates.map((item) => item.id),
	);
	for (const batch of packed.batches) {
		expect(batch.candidates.length).toBeLessThanOrEqual(10);
		expect(jsonBytes(batch.input) + Buffer.byteLength("verifier")).toBeLessThanOrEqual(24000);
	}
	expect(read).toHaveBeenCalledTimes(1);
});
it("rejects only a single oversized verifier candidate and preserves mode metadata", async () => {
	const patch = "diff --git a/a.ts b/a.ts\nold mode 100755\nnew mode 100644\n";
	const snapshot = {
		changes: [{ ...change("a.ts", patch), metadataOnly: true }],
		read: async () => Buffer.from("rules"),
	} as unknown as Snapshot;
	const huge = {
		...candidate("huge"),
		evidence: Array.from({ length: 8 }, () => ({
			file: "a.ts",
			side: "new" as const,
			line: 1,
			quote: "q".repeat(4000),
		})),
	};
	const packed = await packVerificationInputs({
		project: "Project",
		candidates: [candidate("F1"), huge, candidate("F2")],
		lenses: [lens],
		snapshot,
		system: "verifier",
		maxBytes: 24000,
		maxJobs: 10,
		signal: signal(),
	});
	expect(packed.rejected.map((item) => item.id)).toEqual(["huge"]);
	expect(packed.batches.flatMap((batch) => batch.candidates).map((item) => item.id)).toEqual(["F1", "F2"]);
	expect(packed.batches[0]!.input.changes[0]!.patch).toBe(patch);
});
it("accounts for different reviewers' document unions and the ten-candidate schema cap", async () => {
	const other: Lens = { ...lens, id: "other", name: "Other", reading: ["other.md"] };
	const snapshot = {
		changes: [change("a.ts", "diff")],
		read: async () => Buffer.from("d".repeat(6000)),
	} as unknown as Snapshot;
	const first = { ...candidate("F1"), problem: "p", suggestion: "s" };
	const second = { ...first, id: "F2", reviewer: "Other" };
	const packed = await packVerificationInputs({
		project: "p",
		candidates: [first, second],
		lenses: [lens, other],
		snapshot,
		system: "v",
		maxBytes: 10000,
		maxJobs: 3,
		signal: signal(),
	});
	expect(packed.batches).toHaveLength(2);
	const countBound = await packVerificationInputs({
		project: "p",
		candidates: Array.from({ length: 11 }, (_, i) => ({ ...first, id: `F${i}` })),
		lenses: [lens],
		snapshot,
		system: "v",
		maxBytes: 120000,
		maxJobs: 2,
		signal: signal(),
	});
	expect(countBound.batches.map((batch) => batch.candidates.length)).toEqual([10, 1]);
});
