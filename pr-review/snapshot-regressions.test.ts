import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { snapshotTools } from "./snapshot.js";
import { checkEvidence } from "./findings.js";
import { prepareViewerPatch } from "./plannotator.js";
import { capture, commit, fixture, put, testConfig } from "./test-fixtures.js";
import type { Finding } from "./types.js";

it("uses indexed source/anchor ranges and streamed viewer export without eager getters", async () => {
	const repo = await fixture(),
		output = await mkdtemp(join(tmpdir(), "pr-patch-export-"));
	await put(repo.root, "large.ts", "stable\n");
	await commit(repo.root);
	const lines = ["stable", ...Array.from({ length: 25000 }, (_, i) => `row${i}`), "λ🙂".repeat(10000)];
	await put(repo.root, "large.ts", lines.join("\n") + "\n");
	const snapshot = await capture(repo, { kind: "local" }, testConfig);
	try {
		const change = snapshot.changes[0]!;
		expect(change.changedRanges?.new).toEqual([[2, lines.length]]);
		for (const key of ["patch", "oldLines", "newLines"])
			Object.defineProperty(change, key, {
				get: () => {
					throw new Error(`Eager ${key} access`);
				},
			});
		vi.spyOn(snapshot, "read").mockRejectedValue(new Error("Full-buffer source read"));
		const finding: Finding = {
			title: "Fixture",
			severity: "medium",
			file: "large.ts",
			side: "new",
			startLine: 20000,
			endLine: 20000,
			problem: "p",
			suggestion: "s",
			rationale: "r",
			evidence: [{ file: "large.ts", side: "new", line: 20000, quote: lines[19999]! }],
		};
		for (let i = 0; i < 8; i++) await checkEvidence(finding, snapshot);
		await expect(checkEvidence({ ...finding, startLine: 1, endLine: 1 }, snapshot)).rejects.toThrow(
			"changed hunk",
		);
		const tools = snapshotTools(snapshot);
		const read = await tools
			.find((tool) => tool.name === "read")!
			.execute("read", { path: "large.ts", offset: 20000, limit: 1 }, new AbortController().signal);
		expect(JSON.stringify(read.content)).toContain(lines[19999]);
		expect(JSON.stringify(read.content).length).toBeLessThan(300);
		const before = await tools
			.find((tool) => tool.name === "read_before")!
			.execute("old", { path: "large.ts" }, new AbortController().signal);
		expect(JSON.stringify(before.content)).toContain("stable");
		await tools
			.find((tool) => tool.name === "read_change")!
			.execute("legacy", { path: "large.ts", offset: 200 }, new AbortController().signal);
		await prepareViewerPatch(snapshot, output, new AbortController().signal);
		expect(await readFile(join(output, "diff.patch"))).toEqual(await readFile(change.patchPath!));
	} finally {
		await snapshot.dispose?.();
		await rm(repo.root, { recursive: true, force: true });
		await rm(output, { recursive: true, force: true });
	}
});

it.each([{ cursor: 0 }, { offset: 1 }])("never credits an aborted captured diff read (%j)", async (args) => {
	const repo = await fixture();
	await put(repo.root, "a.ts", "new\n".repeat(10000));
	const snapshot = await capture(repo, { kind: "local" }, testConfig);
	try {
		const delivered = vi.fn(),
			tool = snapshotTools(snapshot, delivered).find((tool) => tool.name === "read_change")!;
		await expect(tool.execute("aborted", { path: "a.ts", ...args }, AbortSignal.abort())).rejects.toThrow();
		expect(delivered).not.toHaveBeenCalled();
		const controller = new AbortController();
		const pending = tool.execute("during-read", { path: "a.ts", ...args }, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(delivered).not.toHaveBeenCalled();
	} finally {
		await snapshot.dispose?.();
		await rm(repo.root, { recursive: true, force: true });
	}
});

it("only loads a fixed regular viewer-owned aggregate in the isolated helper", async () => {
	const { readOwnedViewerPatch } = await import(new URL("./viewer-patch.mjs", import.meta.url).href);
	const dir = await mkdtemp(join(tmpdir(), "pr-viewer-owned-"));
	try {
		await writeFile(join(dir, "owner.json"), JSON.stringify({ kind: "pr-review-viewer", pid: process.pid }));
		await writeFile(join(dir, "diff.patch"), "captured patch");
		expect(await readOwnedViewerPatch(dir, process.pid)).toBe("captured patch");
		await expect(readOwnedViewerPatch(dir, process.pid + 1)).rejects.toThrow("owner");
		await rm(join(dir, "diff.patch"));
		await symlink(join(dir, "owner.json"), join(dir, "diff.patch"));
		await expect(readOwnedViewerPatch(dir, process.pid)).rejects.toThrow();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
