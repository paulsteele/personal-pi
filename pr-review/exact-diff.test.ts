import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker as NodeWorker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { ExactDiffWorker } from "./exact-diff.js";
import { capture, fixture, put, testConfig } from "./test-fixtures.js";

const observed = vi.hoisted(() => ({
	workers: [] as NodeWorker[],
	onPost: undefined as (() => void) | undefined,
}));
vi.mock("node:worker_threads", async (original) => {
	const actual = await original<typeof import("node:worker_threads")>();
	return {
		...actual,
		Worker: class extends actual.Worker {
			constructor(...args: ConstructorParameters<typeof actual.Worker>) {
				super(...args);
				observed.workers.push(this);
			}
			override postMessage(value: unknown) {
				super.postMessage(value);
				observed.onPost?.();
			}
		},
	};
});
afterEach(async () => {
	observed.onPost = undefined;
	await Promise.all(observed.workers.splice(0).map((worker) => worker.terminate()));
});

it("amortizes diff startup across a capture and awaits worker exit before returning", async () => {
	const repo = await fixture();
	for (let i = 0; i < 20; i++) await put(repo.root, `${i}.ts`, `new content ${i}\n`);
	const snapshot = await capture(repo, { kind: "local" }, testConfig);
	try {
		expect(snapshot.omitted).toEqual([]);
		expect(snapshot.changes).toHaveLength(20);
		expect(observed.workers).toHaveLength(1);
		expect(observed.workers[0]!.threadId).toBe(-1);
		for (const change of snapshot.changes) {
			expect(change.patch).toContain(`+new content ${change.file.slice(0, -3)}`);
			expect(change.changedRanges?.new).toEqual([[1, 1]]);
		}
	} finally {
		await snapshot.dispose?.();
		await rm(repo.root, { recursive: true, force: true });
	}
});

it.each(["error", "abort", "exit"])("retires and replaces the diff worker after %s", async (mode) => {
	const directory = await mkdtemp(join(tmpdir(), "pr-diff-worker-"));
	const owner = new ExactDiffWorker();
	const controller = new AbortController();
	try {
		const oldFile = join(directory, "old"),
			newFile = join(directory, "new");
		await writeFile(oldFile, "old\n");
		await writeFile(newFile, "new\n");
		const data = { oldFile, newFile, oldPath: "a.ts", file: "a.ts", oldMode: "100644", newMode: "100644" };
		if (mode === "abort") observed.onPost = () => controller.abort();
		if (mode === "exit")
			observed.onPost = () => {
				void observed.workers.at(-1)!.terminate();
			};
		await expect(
			owner.diff(
				{
					...data,
					...(mode === "error" ? { oldFile: join(directory, "missing") } : {}),
					output: join(directory, "failed.patch"),
				},
				controller.signal,
			),
		).rejects.toThrow();
		expect(observed.workers[0]!.threadId).toBe(-1);
		observed.onPost = undefined;
		const result = await owner.diff({ ...data, output: join(directory, "success.patch") });
		expect(result).toEqual({ metadataOnly: false, oldRanges: [[1, 1]], newRanges: [[1, 1]] });
		expect(await readFile(join(directory, "success.patch"), "utf8")).toContain("+new");
		expect(observed.workers).toHaveLength(2);
		await owner.dispose();
		expect(observed.workers.every((worker) => worker.threadId === -1)).toBe(true);
	} finally {
		await owner.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});

it("does not start a worker for pre-cancelled capture work", async () => {
	const owner = new ExactDiffWorker();
	await expect(owner.diff({}, AbortSignal.abort())).rejects.toThrow();
	expect(observed.workers).toEqual([]);
	await owner.dispose();
});
