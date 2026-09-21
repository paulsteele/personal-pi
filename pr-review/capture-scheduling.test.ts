import { rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import * as gitCommands from "./git.js";
import { capture, commit, fixture, put, testConfig } from "./test-fixtures.js";
import type { Snapshot } from "./snapshot.js";

it("does not spend event-loop turns on a large unchanged manifest", async () => {
	const repo = await fixture();
	let snapshot: Snapshot | undefined;
	try {
		await put(repo.root, "a.ts", "before\n");
		await commit(repo.root);
		await put(repo.root, "a.ts", "after\n");
		const git = gitCommands.git;
		const oid = (await git(repo.root, ["rev-parse", "HEAD:a.ts"])).toString().trim();
		// Synthetic metadata only: these unchanged paths must never need a source read.
		const manifest = Buffer.from(
			Array.from({ length: 36_000 }, (_, i) => `100644 blob ${oid}\tz${i}.ts\0`).join(""),
		);
		vi.spyOn(gitCommands, "git").mockImplementation(async (...args) => {
			const result = await git(...args);
			return args[1][0] === "ls-tree" ? Buffer.concat([result, manifest]) : result;
		});
		const yields = vi.spyOn(globalThis, "setImmediate");
		snapshot = await capture(repo, { kind: "local" }, testConfig);
		expect(snapshot.paths()).toHaveLength(36_001);
		expect(snapshot.omitted).toEqual([]);
		expect(snapshot.changes.map((change) => change.file)).toEqual(["a.ts"]);
		expect(snapshot.changes[0]!.added).toEqual(["after"]);
		// One cooperative yield for the actual change, not 36,001 opportunities for an expensive redraw.
		expect(yields).toHaveBeenCalledTimes(1);
	} finally {
		vi.restoreAllMocks();
		await snapshot?.dispose?.();
		await rm(repo.root, { recursive: true, force: true });
	}
});
