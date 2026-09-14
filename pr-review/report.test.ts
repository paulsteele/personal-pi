import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { renderReport, saveReport } from "./report.js";
import { hash } from "./prompts.js";
import { readStored } from "./storage.js";
import type { Report } from "./types.js";
it("keeps bounded private history and distinguishes incomplete from clean", async () => {
	const root = await mkdtemp(join(tmpdir(), "pr-report-"));
	try {
		const base: Report = {
			version: 1,
			id: randomUUID(),
			repoId: hash("fixture"),
			project: "Fixture",
			createdAt: new Date().toISOString(),
			scope: { kind: "local" },
			baseline: null,
			head: null,
			fingerprint: "fixture",
			profileHash: "fixture",
			promptHashes: {},
			model: "fake",
			status: "incomplete",
			lenses: [],
			declined: [],
			clean: [],
			issues: ["worker failed"],
			omitted: [],
			changedFiles: 1,
			findings: [],
			groups: [],
			ledger: [],
			elapsedMs: 0,
			usage: { input: 0, output: 0, cost: 0 },
		};
		expect(renderReport(base)).toContain("not a clean-pass claim");
		for (let i = 0; i < 4; i++)
			await saveReport(root, { ...base, id: randomUUID(), createdAt: new Date(1000 * i).toISOString() }, 2);
		expect(await readdir(join(root, "repos", base.repoId, "reports"))).toHaveLength(2);
		// Full reports must not be rejected by the smaller configuration-record size guard.
		const large = { ...base, issues: ["x".repeat(2200000)] };
		await saveReport(root, large, 2);
		const path = join(root, "repos", base.repoId, "reports", large.id + ".json");
		expect(((await readStored(root, path))!.value as Report).issues[0]!.length).toBe(2200000);
		await saveReport(root, { ...large, issues: [] }, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
