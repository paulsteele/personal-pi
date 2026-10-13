import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { snapshotTools } from "./snapshot.js";
import { capture, fixture, put, testConfig } from "./test-fixtures.js";

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
