import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { hash } from "./prompts.js";
import { saveReport } from "./report.js";
import type { Report } from "./types.js";
const barrier = vi.hoisted(() => ({ path: "", arrivals: 0, wait: Promise.resolve(), release: () => {} }));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		rm: async (...args: Parameters<typeof fs.rm>) => {
			if (String(args[0]) === barrier.path) {
				if (++barrier.arrivals === 2) barrier.release();
				await barrier.wait;
			}
			return fs.rm(...args);
		},
	};
});
it("lets concurrent saves remove the same expired report without rejecting either save", async () => {
	const root = await mkdtemp(join(tmpdir(), "pr-retention-race-"));
	try {
		const base: Report = {
			version: 1,
			id: randomUUID(),
			repoId: hash("fixture"),
			project: "Fixture",
			createdAt: new Date(0).toISOString(),
			scope: { kind: "local" },
			baseline: null,
			head: null,
			fingerprint: "fixture",
			profileHash: "fixture",
			promptHashes: {},
			model: "fake",
			status: "complete",
			lenses: [],
			declined: [],
			clean: [],
			issues: [],
			omitted: [],
			changedFiles: 0,
			findings: [],
			groups: [],
			ledger: [],
			elapsedMs: 0,
			usage: { input: 0, output: 0, cost: 0 },
		};
		await saveReport(root, base, 10);
		barrier.path = join(root, "repos", base.repoId, "reports", `${base.id}.json`);
		barrier.wait = new Promise<void>((resolve) => {
			barrier.release = resolve;
		});
		await Promise.all([
			saveReport(root, { ...base, id: randomUUID(), createdAt: new Date(1000).toISOString() }, 1),
			saveReport(root, { ...base, id: randomUUID(), createdAt: new Date(2000).toISOString() }, 1),
		]);
		expect(barrier.arrivals).toBe(2);
		await expect(access(barrier.path)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		barrier.release();
		barrier.path = "";
		await rm(root, { recursive: true, force: true });
	}
});
