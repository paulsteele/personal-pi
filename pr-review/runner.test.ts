import { rm } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { boundedMap } from "./runner.js";
import { loadPrompts } from "./prompts.js";
import { runWorker } from "./worker.js";
import { ReviewPermissions } from "./permissions.js";
import {
	ReviewSubmission,
	VerificationSubmission,
	ProposalSubmission,
	ConsolidationSubmission,
	type Profile,
	type Finding,
} from "./types.js";
import { awaitWithSignal, createWorkUI } from "./work-ui.js";
import { TaskStore, RecoveryGate } from "./tasks.js";
import { uiHarness } from "./ui.test.helpers.js";
import { review, capture, commit, fixture, put, testConfig, testDraft } from "./test-fixtures.js";
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
	if (withProposalUI) await put(repo.root, "b.ts", "unrelated before\n");
	await commit(repo.root);
	await put(repo.root, "a.ts", "export const enabled = true;\n");
	if (withProposalUI) await put(repo.root, "b.ts", "unrelated after\n");
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
it("bounds resident preparation and reports automatic checks separately from slot waits", async () => {
	const repo = await fixture();
	roots.push(repo.root);
	await put(repo.root, "a.ts", "before\n");
	await commit(repo.root);
	await put(repo.root, "a.ts", "after\n");
	const snapshot = await capture(repo, { kind: "local" }, testConfig);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let prepared = 0,
		peak = 0;
	vi.mocked(runWorker).mockImplementation((async (options: Parameters<typeof runWorker>[0]) => {
		if (options.schema === ProposalSubmission)
			return { ok: true, value: { specialists: [] }, usage: { input: 0, output: 0, cost: 0 } };
		prepared++;
		peak = Math.max(peak, prepared);
		await options.suspendPermissions!(async () => gate);
		prepared--;
		return {
			ok: true,
			value: { complete: true, limitations: [], findings: [] },
			usage: { input: 0, output: 0, cost: 0 },
		};
	}) as typeof runWorker);
	const tasks = new TaskStore();
	const pending = review({
		ctx: { modelRegistry: {} } as ExtensionContext,
		config: { ...testConfig, concurrency: 2 },
		profile: {
			schemaVersion: 1,
			contextVersion: 1,
			repoId: repo.id,
			generatedAt: "now",
			generationModel: "fake",
			sourceHashes: {},
			draft: testDraft,
		},
		snapshot,
		prompts: await loadPrompts(),
		scope: { kind: "local" },
		signal: new AbortController().signal,
		progress() {},
		tasks,
	});
	try {
		await vi.waitFor(() => expect(prepared).toBe(2));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(peak).toBe(2);
		expect(tasks.snapshot().filter((task) => task.state === "waiting_slot")).toHaveLength(4);
		expect(tasks.snapshot().filter((task) => task.state === "checking")).toHaveLength(2);
		expect(tasks.snapshot().filter((task) => task.state === "permission")).toHaveLength(0);
	} finally {
		release();
		await pending;
		await snapshot.dispose?.();
	}
});

it.each(["scout", "consolidate"])(
	"retries a permission-blocked optional %s without rerunning completed reviewers",
	async (stage) => {
		const repo = await fixture();
		roots.push(repo.root);
		await put(repo.root, "a.ts", "export const enabled = false;\n");
		await commit(repo.root);
		await put(repo.root, "a.ts", "export const enabled = true;\n");
		const snapshot = await capture(repo, { kind: "local" }, testConfig);
		let retries = 0,
			reviewers = 0,
			optionalCalls = 0;
		const signal = new AbortController().signal,
			tasks = new TaskStore(),
			recovery = new RecoveryGate(tasks, signal);
		tasks.onChange(() => {
			if (!retries && recovery.blockers.has(stage)) {
				retries++;
				if (stage === "consolidate") expect(reviewers).toBe(6);
				queueMicrotask(() => recovery.retry());
			}
		});
		vi.mocked(runWorker).mockImplementation((async (options: Parameters<typeof runWorker>[0]) => {
			const target = stage === "scout" ? ProposalSubmission : ConsolidationSubmission;
			if (options.schema === target && ++optionalCalls === 1)
				return {
					ok: false,
					permissionFailure: true,
					error: "Submission denied",
					usage: { input: 0, output: 0, cost: 0 },
				};
			let value: unknown = { specialists: [] };
			if (options.schema === ReviewSubmission) {
				reviewers++;
				value = {
					complete: true,
					limitations: [],
					findings:
						stage === "consolidate" && (options.input as { lens: { id: string } }).lens.id === "security"
							? [
									finding,
									{
										...finding,
										title: "Another overlapping claim",
										problem: "A different overlapping problem",
									},
								]
							: [],
				};
			} else if (options.schema === VerificationSubmission)
				value = {
					verdicts: (options.input as { candidateIds: string[] }).candidateIds.map((id) => ({
						id,
						verdict: "confirmed",
						reason: "Fixture",
					})),
				};
			else if (options.schema === ConsolidationSubmission) value = { groups: [["F1", "F2"]] };
			return { ok: true, value, usage: { input: 0, output: 0, cost: 0 } };
		}) as typeof runWorker);
		try {
			const report = await review({
				ctx: { modelRegistry: {} } as ExtensionContext,
				config: testConfig,
				profile: {
					schemaVersion: 1,
					contextVersion: 1,
					repoId: repo.id,
					generatedAt: "now",
					generationModel: "fake",
					sourceHashes: {},
					draft: testDraft,
				},
				snapshot,
				prompts: await loadPrompts(),
				scope: { kind: "local" },
				signal,
				progress() {},
				tasks,
				recovery,
			});
			expect(retries).toBe(1);
			expect(optionalCalls).toBe(2);
			expect(reviewers).toBe(6);
			expect(report.status).toBe("complete");
			expect(report.issues).toEqual([]);
		} finally {
			await snapshot.dispose?.();
		}
	},
);

it("rechecks permission on explicit retry without replacing the source snapshot", async () => {
	const repo = await fixture();
	roots.push(repo.root);
	await put(repo.root, "a.ts", "before\n");
	await commit(repo.root);
	await put(repo.root, "a.ts", "after\n");
	const snapshot = await capture(repo, { kind: "local" }, testConfig);
	let allowed = false,
		attempts = 0;
	const permissions = new ReviewPermissions("retry", {
		close() {},
		task: (spec) => ({
			revision: () => (allowed ? "new" : "old"),
			nextTurn() {},
			endTurn() {},
			close() {},
			check: async (action) =>
				spec.id === "review:security" && action.effects?.length && !allowed
					? { kind: "denied", reason: "Change policy then Retry" }
					: { kind: "allowed", revision: allowed ? "new" : "old" },
		}),
	});
	vi.mocked(runWorker).mockImplementation((async (options: Parameters<typeof runWorker>[0]) => {
		if (options.schema === ProposalSubmission)
			return { ok: true, value: { specialists: [] }, usage: { input: 0, output: 0, cost: 0 } };
		if ((options.input as { lens?: { id: string } }).lens?.id === "security") {
			attempts++;
			await options
				.tools!.find((tool) => tool.name === "read")!
				.execute("source", { path: "a.ts" }, new AbortController().signal);
		}
		return {
			ok: true,
			value: { complete: true, limitations: [], findings: [] },
			usage: { input: 0, output: 0, cost: 0 },
		};
	}) as typeof runWorker);
	const tasks = new TaskStore(),
		signal = new AbortController().signal,
		recovery = new RecoveryGate(tasks, signal);
	tasks.onChange(() => {
		if (!allowed && recovery.blockers.has("review:security")) {
			allowed = true;
			queueMicrotask(() => recovery.retry());
		}
	});
	try {
		const report = await review({
			ctx: { modelRegistry: {} } as ExtensionContext,
			permissions,
			config: testConfig,
			profile: {
				schemaVersion: 1,
				contextVersion: 1,
				repoId: repo.id,
				generatedAt: "now",
				generationModel: "fake/test",
				sourceHashes: {},
				draft: testDraft,
			},
			snapshot,
			prompts: await loadPrompts(),
			scope: { kind: "local" },
			signal,
			progress() {},
			tasks,
			recovery,
		});
		expect(attempts).toBe(2);
		expect(report.status).toBe("complete");
		expect(report.fingerprint).toBe(snapshot.fingerprint);
	} finally {
		permissions.close();
		await snapshot.dispose?.();
	}
});

it("checks the verifier's source rights before transferring another worker's candidate", async () => {
	const repo = await fixture();
	roots.push(repo.root);
	await put(repo.root, "a.ts", "export const enabled = false;\n");
	await commit(repo.root);
	await put(repo.root, "a.ts", "export const enabled = true;\n");
	const snapshot = await capture(repo, { kind: "local" }, testConfig);
	const permissions = new ReviewPermissions("scoped", {
		close() {},
		task: (spec) => ({
			revision: () => "fixture",
			nextTurn() {},
			endTurn() {},
			close() {},
			check: async (action) =>
				spec.id.startsWith("verify:") && action.effects?.length
					? { kind: "denied", reason: "verifier source denied" }
					: { kind: "allowed", revision: "fixture" },
		}),
	});
	vi.mocked(runWorker).mockImplementation((async (options: Parameters<typeof runWorker>[0]) => {
		if (options.schema === ProposalSubmission)
			return { ok: true, value: { specialists: [] }, usage: { input: 0, output: 0, cost: 0 } };
		const security = (options.input as { lens?: { id: string } }).lens?.id === "security";
		if (security)
			await options
				.tools!.find((tool) => tool.name === "read")!
				.execute("source", { path: "a.ts" }, new AbortController().signal);
		return {
			ok: true,
			value: { complete: true, limitations: [], findings: security ? [finding] : [] },
			usage: { input: 0, output: 0, cost: 0 },
		};
	}) as typeof runWorker);
	try {
		const report = await review({
			ctx: { modelRegistry: {} } as ExtensionContext,
			permissions,
			config: testConfig,
			profile: {
				schemaVersion: 1,
				contextVersion: 1,
				repoId: repo.id,
				generatedAt: "now",
				generationModel: "fake/test",
				sourceHashes: {},
				draft: testDraft,
			},
			snapshot,
			prompts: await loadPrompts(),
			scope: { kind: "local" },
			signal: new AbortController().signal,
			progress() {},
		});
		expect(report.status).toBe("incomplete");
		expect(report.findings).toEqual([]);
		expect(report.ledger).toContainEqual(
			expect.objectContaining({ verdict: "inconclusive", reason: "verifier source denied" }),
		);
		expect(
			vi.mocked(runWorker).mock.calls.some(([options]) => options.schema === VerificationSubmission),
		).toBe(false);
	} finally {
		permissions.close();
		await snapshot.dispose?.();
	}
});

it("runs every baseline and independently verifies before retaining a finding", async () => {
	const { result, seen } = await run("confirmed");
	expect(seen.sort()).toEqual([
		"$architecture",
		"correctness",
		"performance",
		"readability",
		"security",
		"style",
	]);
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
	expect(result.lenses.find((lens) => lens.id === "extra")).toMatchObject({ reading: [], exactScope: true });
	expect(result.tasks!.find((task) => task.name === "Extra lens")!.files).toEqual(["a.ts"]);
	const extra = vi
		.mocked(runWorker)
		.mock.calls.find(([options]) => (options.input as { lens?: { id: string } }).lens?.id === "extra")![0];
	expect(extra.input).toMatchObject({ assignedFiles: ["a.ts"], relatedContextFiles: ["b.ts"] });
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
it.each(["review", "verification"])("frees exhausted capacity during %s recovery", async (stage) => {
	const repo = await fixture();
	roots.push(repo.root);
	await put(repo.root, "a.ts", "export const enabled = false;\n");
	await commit(repo.root);
	await put(repo.root, "a.ts", "export const enabled = true;\n");
	const snapshot = await capture(repo, { kind: "local" }, testConfig);
	const controller = new AbortController();
	const tasks = new TaskStore(),
		recovery = new RecoveryGate(tasks, controller.signal);
	const calls = new Map<string, number>();
	let progressed = false;
	tasks.onChange(() => {
		const ready =
			stage === "review"
				? recovery.blockers.size === 5 && tasks.records.get("review:readability")?.state === "completed"
				: recovery.blockers.has("verify:0") && tasks.records.get("verify:1")?.state === "completed";
		if (ready) {
			progressed = true;
			recovery.retry();
		}
	});
	vi.mocked(runWorker).mockImplementation((async (options: Parameters<typeof runWorker>[0]) => {
		const input = options.input as { lens?: { id: string }; candidateIds?: string[] };
		const id = input.lens?.id ?? input.candidateIds?.[0] ?? "scout";
		calls.set(id, (calls.get(id) ?? 0) + 1);
		let value: unknown = { specialists: [] };
		if (options.schema === ReviewSubmission) {
			if (stage === "review" && id !== "readability") await options.recover!("Fixture obstacle");
			value = {
				complete: true,
				limitations: [],
				findings:
					id === "security"
						? Array.from({ length: 12 }, (_, i) => ({ ...finding, title: `Finding ${i}` }))
						: [],
			};
		} else if (options.schema === VerificationSubmission) {
			if (stage === "verification" && id === "F1") await options.recover!("Verifier obstacle");
			value = { verdicts: input.candidateIds!.map((id) => ({ id, verdict: "dropped", reason: "Fixture" })) };
		}
		return { ok: true, value, usage: { input: 1, output: 1, cost: 0 } };
	}) as typeof runWorker);
	const concurrency = stage === "review" ? 4 : 1;
	try {
		const report = await review({
			ctx: { modelRegistry: {} } as ExtensionContext,
			config: { ...testConfig, concurrency },
			profile: {
				schemaVersion: 1,
				contextVersion: 1,
				repoId: repo.id,
				generatedAt: "fixture",
				generationModel: "fake/test",
				sourceHashes: {},
				draft: testDraft,
			},
			snapshot,
			prompts: await loadPrompts(),
			scope: { kind: "local" },
			signal: controller.signal,
			progress: () => {},
			tasks,
			recovery,
		});
		expect(progressed).toBe(true);
		expect(report.issues).toEqual([]);
		expect(report.ledger).toHaveLength(12);
		expect([...calls.values()].every((count) => count === 1)).toBe(true);
		expect(report.tasks!.every((task) => task.state === "completed")).toBe(true);
		expect(report.metrics!.peakActive).toBeLessThanOrEqual(concurrency);
	} finally {
		controller.abort();
		await snapshot.dispose?.();
	}
});

it("cancels both queued permits and suspended recovery without launching queued work", async () => {
	const controller = new AbortController();
	const started: number[] = [];
	const pending = boundedMap([0, 1, 2], 1, controller.signal, async (item, _index, suspend) => {
		started.push(item);
		const wait = () => awaitWithSignal(new Promise<void>(() => {}), controller.signal);
		if (item === 0) await suspend(wait);
		else await wait();
		return item;
	});
	const rejected = expect(pending).rejects.toThrow("Fixture cancelled");
	await vi.waitFor(() => expect(started).toEqual([0, 1]));
	controller.abort(new Error("Fixture cancelled"));
	await rejected;
	expect(started).toEqual([0, 1]);
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
