import { rm } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { capture } from "./snapshot.js";
import { boundedMap, review } from "./runner.js";
import { loadPrompts } from "./prompts.js";
import { runWorker } from "./worker.js";
import {
	ReviewSubmission,
	VerificationSubmission,
	ProposalSubmission,
	type Profile,
	type Finding,
} from "./types.js";
import { createWorkUI } from "./work-ui.js";
import { uiHarness } from "./ui.test.helpers.js";
import { commit, fixture, put, testConfig, testDraft } from "./test-fixtures.js";
vi.mock("./worker.js", () => ({ runWorker: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
	vi.resetAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const finding: Finding = {
	title: "Changed default",
	severity: "high",
	file: "a.ts",
	side: "new",
	startLine: 1,
	endLine: 1,
	problem: "Fixture problem",
	suggestion: "Fixture change",
	rationale: "Fixture rationale",
	evidence: [{ file: "a.ts", side: "new", line: 1, quote: "export const enabled = true;" }],
};
async function run(
	verdict: "confirmed" | "missing" | "bad-quote",
	withProposalUI = false,
	approveWithMissingReading = false,
) {
	const repo = await fixture();
	roots.push(repo.root);
	await put(repo.root, "a.ts", "export const enabled = false;\n");
	await commit(repo.root);
	await put(repo.root, "a.ts", "export const enabled = true;\n");
	const snapshot = await capture(repo, { kind: "local" }, testConfig);
	const profile: Profile = {
		schemaVersion: 1,
		contextVersion: 1,
		repoId: repo.id,
		generatedAt: "fixture",
		generationModel: "fake/test",
		sourceHashes: {},
		draft: approveWithMissingReading ? { ...testDraft, requiredReading: ["deleted-rules.md"] } : testDraft,
	};
	const actual =
		verdict === "bad-quote"
			? { ...finding, evidence: [{ ...finding.evidence[0]!, quote: "invented quote" }] }
			: finding;
	const seen: string[] = [];
	vi.mocked(runWorker).mockImplementation((async (options: {
		schema: unknown;
		input: { lens?: { id: string } };
	}) => {
		let value: unknown = { specialists: [] };
		if (withProposalUI && options.schema === ProposalSubmission)
			value = {
				specialists: [
					{
						specialist: {
							id: "extra",
							name: "Extra lens",
							focus: "Fixture gap",
							requiredReading: [],
							always: true,
							anyOf: [],
						},
						reason: "Fixture gap",
						files: ["a.ts"],
					},
				],
			};
		if (options.schema === ReviewSubmission) {
			const id = options.input.lens!.id;
			seen.push(id);
			value = { complete: true, limitations: [], findings: id === "security" ? [actual] : [] };
		}
		if (options.schema === VerificationSubmission)
			value = {
				verdicts: verdict === "missing" ? [] : [{ id: "F1", verdict: "confirmed", reason: "checked" }],
			};
		return { ok: true, value, usage: { input: 1, output: 1, cost: 0 } };
	}) as typeof runWorker);
	const h = uiHarness();
	if (approveWithMissingReading) {
		let selected = false;
		h.ui.select = async (_title, options) => {
			if (!selected) {
				selected = true;
				return options.find((value) => value.startsWith("[ ]"));
			}
			return "Continue";
		};
	}
	const controller = new AbortController();
	const ctx = { modelRegistry: {}, ui: h.ui } as ExtensionContext;
	const workUI = createWorkUI(ctx, controller.signal, () => controller.abort());
	const result = await review({
		ctx,
		config: testConfig,
		profile,
		snapshot,
		prompts: await loadPrompts(),
		scope: { kind: "local" },
		signal: controller.signal,
		progress: workUI.update,
		...(withProposalUI ? { work: workUI.run } : {}),
	});
	await snapshot.dispose?.();
	return { result, seen, ui: h.state };
}
it("runs every baseline and independently verifies before retaining a finding", async () => {
	const { result, seen } = await run("confirmed");
	expect(seen.sort()).toEqual(["$architecture", "correctness", "performance", "security", "style"]);
	expect(result.status).toBe("complete");
	expect(result.findings).toHaveLength(1);
	expect(result.ledger).toEqual([{ id: "F1", verdict: "confirmed", reason: "checked" }]);
	expect(result.clean).not.toContain("Security");
});
it.each(["missing", "bad-quote"] as const)("never reports a pass for %s verification", async (mode) => {
	const { result } = await run(mode);
	expect(result.status).toBe("incomplete");
	expect(result.findings).toHaveLength(0);
	expect(result.ledger).toMatchObject([{ id: "F1", verdict: "inconclusive" }]);
});
it("closes the proposal spinner before asking which specialists to run", async () => {
	const { result, seen, ui } = await run("confirmed", true);
	expect(result.status).toBe("complete");
	expect(result.declined).toContain("Extra lens");
	expect(seen).not.toContain("extra");
	expect(ui.nativeDialogs.some((title) => title.startsWith("Add specialists"))).toBe(true);
	expect(ui.active).toBeUndefined();
	expect(ui.closes).toBe(ui.factories);
});

it("does not restore missing inherited documents when a proposed specialist is approved", async () => {
	const { result, seen } = await run("confirmed", true, true);
	expect(seen).toContain("extra");
	expect(result.status).toBe("complete");
	expect(result.contextNotes?.join(" ")).toContain("deleted-rules.md");
	expect(result.lenses.find((lens) => lens.id === "extra")!.reading).toEqual([]);
	for (const [options] of vi.mocked(runWorker).mock.calls)
		if (options.schema === VerificationSubmission) {
			expect(options.coverage!.ids).toContain("candidate:F1");
			const iterator = options.resources![Symbol.asyncIterator]();
			const first = await iterator.next();
			expect(first.value).toMatchObject({
				id: "candidate:F1",
				text: expect.stringContaining("Fixture problem"),
			});
			await iterator.return?.();
		}
});
it("bounds parallelism and preserves input-order results", async () => {
	let active = 0,
		peak = 0;
	const result = await boundedMap([0, 1, 2, 3, 4], 2, new AbortController().signal, async (item) => {
		active++;
		peak = Math.max(active, peak);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active--;
		return item * 2;
	});
	expect(peak).toBe(2);
	expect(result).toEqual([0, 2, 4, 6, 8]);
});
