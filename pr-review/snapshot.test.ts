import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveRepo } from "./git.js";
import { capture, commit, fixture, put, testConfig, testGit } from "./test-fixtures.js";

const roots: string[] = [];
async function repo() {
	const r = await fixture();
	roots.push(r.root);
	return r;
}
afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

it("supports unborn repositories, ignores ignored paths, and does not follow symlinks", async () => {
	const r = await repo();
	await put(r.root, ".gitignore", "ignored\n");
	await put(r.root, "ignored", "private");
	await put(r.root, "added.ts", "new\n");
	await testGit(r.root, "add", "added.ts");
	await symlink("/etc/passwd", join(r.root, "link"));
	const snapshot = await capture(r, { kind: "local" }, testConfig);
	expect(snapshot.baseline).toBeNull();
	expect(snapshot.paths()).not.toContain("ignored");
	expect(snapshot.changes.some((c) => c.file === "added.ts")).toBe(true);
	await expect(snapshot.read("link")).rejects.toThrow();
	await expect(snapshot.read("../escape")).rejects.toThrow();
	expect(snapshot.omitted.some((c) => c.file === "link")).toBe(true);
});

it("shares common-directory identities across worktrees but not clones", async () => {
	const r = await repo();
	await put(r.root, "a.ts", "a\n");
	await commit(r.root);
	const parent = await repo();
	const path = join(parent.root, "linked");
	await testGit(r.root, "worktree", "add", "--detach", path);
	expect((await resolveRepo(path)).id).toBe(r.id);
	expect(parent.id).not.toBe(r.id);
});
