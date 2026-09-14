import { rm, stat } from "node:fs/promises";
import { expect, it } from "vitest";
import { capture, snapshotTools, type Snapshot } from "./snapshot.js";
import { CoverageLedger } from "./tasks.js";
import { SnapshotStore, textPage } from "./snapshot-store.js";
import { fixture, put, testConfig } from "./test-fixtures.js";

it("counts normal reads and legacy diff offsets automatically without checkpoint acknowledgments", async () => {
	const ledger = new CoverageLedger(["doc:rules.md", "diff:a.ts"]);
	const snapshot = {
		repo: { root: process.cwd() },
		read: async () => Buffer.from("fixture rule\n"),
		changes: [
			{ file: "a.ts", oldPath: "a.ts", patch: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n" },
		],
	} as unknown as Snapshot;
	const tools = snapshotTools(snapshot, (...args) => ledger.deliver(...args));
	await tools
		.find((tool) => tool.name === "read")!
		.execute("test", { path: "rules.md" }, new AbortController().signal);
	await tools
		.find((tool) => tool.name === "read_change")!
		.execute("test", { path: "a.ts", offset: 1 }, new AbortController().signal);
	expect(ledger.remaining).toEqual([]);
	ledger.assertComplete();
});
it("seeks UTF-8 indexes without losing split code points or a BOM", async () => {
	const repo = await fixture(),
		store = await SnapshotStore.create(repo);
	try {
		const original = "\uFEFF" + "🙂漢λ".repeat(15000),
			path = await store.put(original);
		let cursor: number | null = 0,
			restored = "";
		while (cursor !== null) {
			const page = await textPage(path, cursor, 9997);
			restored += page.text;
			cursor = page.nextOffset;
		}
		expect(restored).toBe(original);
	} finally {
		await store.dispose();
		await rm(repo.root, { recursive: true, force: true });
	}
});
it("captures over old size/line limits and pages long lines without gaps", async () => {
	const repo = await fixture();
	let snapshot: Awaited<ReturnType<typeof capture>> | undefined;
	try {
		const text = "λ".repeat(40000) + "\n" + "line\n".repeat(21000);
		await put(repo.root, "large.ts", text);
		snapshot = await capture(repo, { kind: "local" }, {
			...testConfig,
			maxFileBytes: 1,
			maxDiffBytes: 1,
		} as typeof testConfig);
		expect(snapshot.omitted).toEqual([]);
		const ledger = new CoverageLedger(["diff:large.ts"]);
		const tool = snapshotTools(snapshot, (...args) => ledger.deliver(...args)).find(
			(t) => t.name === "read_change",
		)!;
		let cursor = 0;
		while (cursor < snapshot.changes[0]!.patch.length) {
			await tool.execute("test", { path: "large.ts", cursor, limit: 16000 }, new AbortController().signal);
			cursor += 16000;
		}
		ledger.checkpoint({ key: "done", reviewed: ["diff:large.ts"], notes: "Reviewed", findings: [] });
		ledger.assertComplete();
		expect((await stat(snapshot.changes[0]!.patchPath!)).mode & 0o777).toBe(0o600);
		await put(repo.root, "large.ts", "drift");
		expect((await snapshot.read("large.ts")).toString()).toBe(text);
		const backing = snapshot.changes[0]!.patchPath!;
		await snapshot.dispose!();
		await expect(stat(backing)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await snapshot?.dispose?.();
		await rm(repo.root, { recursive: true, force: true });
	}
});
