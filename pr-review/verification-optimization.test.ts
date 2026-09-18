import { rm } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { runWorker } from "./worker.js";
import { review } from "./runner.js";
import { capture, type Snapshot } from "./snapshot.js";
import { loadPrompts } from "./prompts.js";
import { deduplicateCandidates, needsSemanticConsolidation, validateGroups } from "./findings.js";
import { packVerificationInputs } from "./batching.js";
import { ReviewSubmission, VerificationSubmission, type Candidate } from "./types.js";
import { fixture, put, commit, testConfig, testDraft } from "./test-fixtures.js";
import { emptyUsage, providerUsage } from "./usage.js";
import { TaskStore, RecoveryGate } from "./tasks.js";
vi.mock("./worker.js", () => ({ runWorker: vi.fn() }));
afterEach(() => vi.resetAllMocks());
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
it.each(["confirmed", "corrected", "dropped", "inconclusive", "missing", "bad-correction", "failed"])(
	"maps a shared %s verdict to all original IDs and unions reviewer guidance",
	async (mode) => {
		const repo = await fixture();
		let snapshot: Snapshot | undefined;
		try {
			await put(repo.root, "a.ts", "export const enabled = false;\n");
			for (const doc of ["common.md", "security.md", "correctness.md"])
				await put(repo.root, doc, `Guidance for ${doc}\n`);
			await commit(repo.root);
			await put(repo.root, "a.ts", "export const enabled = true;\n");
			snapshot = await capture(repo, { kind: "local" }, testConfig);
			const verifierCalls: unknown[] = [],
				sessionIds = new Set<string>();
			vi.mocked(runWorker).mockImplementation((async (options: Parameters<typeof runWorker>[0]) => {
				sessionIds.add(options.sessionId!);
				const input = options.input as {
					lens?: { id: string; focus?: string; reading?: string[] };
					requiredReading?: string[];
					candidateIds?: string[];
				};
				let value: unknown = { specialists: [] };
				if (options.schema === ReviewSubmission) {
					expect(input.lens?.reading).toBeUndefined();
					if (input.lens?.id === "$architecture") expect(input.lens.focus).toBeUndefined();
					const { id: _, reviewer: _reviewer, ...body } = finding;
					value = {
						complete: true,
						limitations: [],
						findings: ["security", "correctness"].includes(input.lens!.id) ? [body] : [],
					};
				} else if (options.schema === VerificationSubmission) {
					verifierCalls.push(input);
					expect(input.candidateIds).toEqual(["F1"]);
					expect(input.requiredReading?.sort()).toEqual(["common.md", "correctness.md", "security.md"]);
					const supplied = [];
					for await (const item of options.sharedResources!) supplied.push(item);
					for await (const item of options.resources!) supplied.push(item);
					expect(supplied.filter((r) => r.id.startsWith("candidate:")).map((r) => r.id)).toEqual([
						"candidate:F1",
					]);
					for (const r of supplied) options.coverage!.deliver(r.id, 0, r.total, r.total);
					expect(options.coverage!.remaining).toEqual([]);
					if (mode === "failed") return { ok: false, error: "Fixture failure", usage: emptyUsage() };
					const { id: _, reviewer: _reviewer, ...body } = finding;
					value = {
						verdicts:
							mode === "missing"
								? []
								: [
										{
											id: "F1",
											verdict: mode === "bad-correction" ? "corrected" : mode,
											reason: "Checked once",
											...(mode === "corrected" || mode === "bad-correction"
												? {
														corrected: {
															...body,
															title: "Corrected title",
															severity: mode === "bad-correction" ? "high" : body.severity,
														},
													}
												: {}),
										},
									],
					};
					try {
						await options.validateResult!(value);
					} catch {
						return { ok: false, error: "Invalid verification", usage: emptyUsage() };
					}
				}
				return { ok: true, value, usage: emptyUsage() };
			}) as typeof runWorker);
			const report = await review({
				ctx: { modelRegistry: {} } as ExtensionContext,
				config: testConfig,
				profile: {
					schemaVersion: 1,
					contextVersion: 1,
					repoId: repo.id,
					generatedAt: "fixture",
					generationModel: "fake/test",
					sourceHashes: {},
					draft: {
						...testDraft,
						requiredReading: ["common.md"],
						baselineFocus: [
							{ id: "security", focus: "Security contracts", requiredReading: ["security.md"] },
							{ id: "correctness", focus: "Correctness contracts", requiredReading: ["correctness.md"] },
						],
					},
				},
				snapshot,
				prompts: await loadPrompts(),
				scope: { kind: "local" },
				signal: new AbortController().signal,
				progress: () => {},
			});
			expect(verifierCalls).toHaveLength(1);
			expect(sessionIds.size).toBe(7);
			expect(report.ledger.map((v) => v.id)).toEqual(["F1", "F2"]);
			expect(report.ledger[1]!.sharedWith).toBe("F1");
			expect(report.tasks?.some((t) => t.stage === "consolidation")).toBe(false);
			if (["confirmed", "corrected"].includes(mode)) {
				expect(report.findings.map((f) => f.reviewer).sort()).toEqual(["Correctness", "Security"]);
				expect(report.findings.map((f) => f.id)).toEqual(["F1", "F2"]);
				expect(report.groups).toEqual([["F1", "F2"]]);
				expect(report.status).toBe("complete");
				if (mode === "corrected")
					expect(report.findings.every((f) => f.title === "Corrected title")).toBe(true);
			} else {
				expect(report.findings).toEqual([]);
				expect(
					report.ledger.every((v) => v.verdict === (mode === "dropped" ? "dropped" : "inconclusive")),
				).toBe(true);
			}
		} finally {
			await snapshot?.dispose?.();
			await rm(repo.root, { recursive: true, force: true });
		}
	},
);
it("keeps routing IDs and cumulative cache usage across a host-level worker restart", async () => {
	const repo = await fixture();
	let snapshot: Snapshot | undefined;
	try {
		await put(repo.root, "a.ts", "old\n");
		await commit(repo.root);
		await put(repo.root, "a.ts", "new\n");
		snapshot = await capture(repo, { kind: "local" }, testConfig);
		const signal = new AbortController().signal;
		const tasks = new TaskStore(),
			recovery = new RecoveryGate(tasks, signal);
		const attempts: Array<{ sessionId: string | undefined; continuing: boolean | undefined }> = [];
		const measured = {
			input: 1,
			output: 2,
			cacheRead: 30,
			cacheWrite: 4,
			totalTokens: 37,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		tasks.onChange(() => {
			if (recovery.blockers.size) recovery.retry();
		});
		vi.mocked(runWorker).mockImplementation((async (options: Parameters<typeof runWorker>[0]) => {
			options.event?.({ type: "request", text: "Fixture request" });
			const lens = (options.input as { lens?: { id: string } }).lens;
			if (lens?.id === "correctness") {
				attempts.push({ sessionId: options.sessionId, continuing: options.continuing });
				const usage = providerUsage(measured, options.continuing ? "continuation" : "first");
				usage.byRequest![options.continuing ? "continuation" : "first"].requests = 1;
				if (attempts.length === 1) return { ok: false, error: "Fixture restart", usage };
				return { ok: true, value: { complete: true, limitations: [], findings: [] }, usage };
			}
			return {
				ok: true,
				value: lens ? { complete: true, limitations: [], findings: [] } : { specialists: [] },
				usage: emptyUsage(),
			};
		}) as typeof runWorker);
		const report = await review({
			ctx: { modelRegistry: {} } as ExtensionContext,
			config: testConfig,
			snapshot,
			profile: {
				schemaVersion: 1,
				contextVersion: 1,
				repoId: repo.id,
				generatedAt: "fixture",
				generationModel: "fake/test",
				sourceHashes: {},
				draft: testDraft,
			},
			prompts: await loadPrompts(),
			scope: { kind: "local" },
			signal,
			progress: () => {},
			tasks,
			recovery,
		});
		expect(report.status).toBe("complete");
		expect(attempts).toHaveLength(2);
		expect(attempts[0]!.sessionId).toBeTruthy();
		expect(attempts[0]!.sessionId).toBe(attempts[1]!.sessionId);
		expect(attempts.map((a) => a.continuing)).toEqual([false, true]);
		expect(report.usage.cacheRead).toBe(60);
		expect(report.usage.cost).toBe(2);
		expect(report.usage.byRequest?.first.requests).toBe(1);
		expect(report.usage.byRequest?.continuation.requests).toBe(1);
	} finally {
		await snapshot?.dispose?.();
		await rm(repo.root, { recursive: true, force: true });
	}
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
