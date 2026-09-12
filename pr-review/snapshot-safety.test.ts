import { access, chmod, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { resolveRepo } from "./git.js";
import { capture, assertCurrent, snapshotTools, type Snapshot } from "./snapshot.js";
import { commit, fixture, put, testConfig, testGit } from "./test-fixtures.js";
const roots: string[] = [];
async function repo() {
	const result = await fixture();
	roots.push(result.root);
	return result;
}
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each([".git", "private"])(
	"never reads a tracked child through an ancestor symlink into %s",
	async (destination) => {
		const r = await repo();
		await put(r.root, "docs/config", "public fixture\n");
		await commit(r.root);
		if (destination === ".git")
			await testGit(r.root, "config", "test.privateMarker", "SYNTHETIC_PRIVATE_MARKER");
		else {
			await put(r.root, "private/config", "SYNTHETIC_PRIVATE_MARKER\n");
			await put(r.root, ".gitignore", "private/\n");
		}
		await rm(join(r.root, "docs"), { recursive: true });
		await symlink(destination, join(r.root, "docs"));
		const snapshot = await capture(r, { kind: "local" }, testConfig);
		await expect(snapshot.read("docs/config")).rejects.toThrow("symlink ancestor");
		expect(snapshot.omitted.some((item) => item.file === "docs/config")).toBe(true);
		expect(snapshot.changes.map((item) => item.patch).join("")).not.toContain("SYNTHETIC_PRIVATE_MARKER");
	},
);
it("captures directory-to-file replacement as a deleted child and new file", async () => {
	const r = await repo();
	await put(r.root, "dir/child.ts", "old child\n");
	await commit(r.root);
	await rm(join(r.root, "dir"), { recursive: true });
	await put(r.root, "dir", "replacement\n");
	const snapshot = await capture(r, { kind: "local" }, testConfig);
	expect(snapshot.changes.find((item) => item.file === "dir/child.ts")?.removed).toEqual(["old child"]);
	expect(snapshot.changes.find((item) => item.file === "dir")?.added).toEqual(["replacement"]);
});
it.each(["--assume-unchanged", "--skip-worktree"])(
	"refuses hidden tracked changes under %s without changing flags",
	async (flag) => {
		const r = await repo();
		await put(r.root, "AGENTS.md", "original\n");
		await commit(r.root);
		const snapshot = await capture(r, { kind: "local" }, testConfig);
		await testGit(r.root, "update-index", flag, "AGENTS.md");
		await put(r.root, "AGENTS.md", "changed\n");
		const flags = await testGit(r.root, "ls-files", "-v");
		await expect(capture(r, { kind: "local" }, testConfig)).rejects.toThrow("Index flags");
		await expect(assertCurrent(snapshot, testConfig)).rejects.toThrow("Index flags");
		expect(await testGit(r.root, "ls-files", "-v")).toBe(flags);
	},
);
it("distinguishes genuine root commits from unavailable shallow ancestry", async () => {
	const r = await repo();
	await put(r.root, "a.txt", "one\n");
	await commit(r.root);
	expect((await capture(r, { kind: "local" }, testConfig)).baseline).toBeNull();
	await put(r.root, "a.txt", "two\n");
	await commit(r.root);
	const parent = await mkdtemp(join(tmpdir(), "pr-shallow-"));
	roots.push(parent);
	await testGit(parent, "clone", "--depth", "1", pathToFileURL(r.root).href, "checkout");
	const shallow = await resolveRepo(join(parent, "checkout"));
	expect((await testGit(shallow.root, "rev-parse", "--is-shallow-repository")).trim()).toBe("true");
	await expect(capture(shallow, { kind: "local" }, testConfig)).rejects.toThrow(
		"First-parent history is unavailable",
	);
});
it.each(["clean", "process"])(
	"never executes an active %s filter during capture or drift checking",
	async (kind) => {
		const r = await repo();
		await put(r.root, "a.txt", "one\n");
		await commit(r.root);
		const snapshot = await capture(r, { kind: "local" }, testConfig);
		await put(r.root, ".gitattributes", "*.txt filter=probe\n");
		await testGit(
			r.root,
			"config",
			`filter.probe.${kind}`,
			kind === "clean" ? "sh -c 'printf ran > filter-ran; cat'" : "sh -c 'printf ran > filter-ran; exit 1'",
		);
		await put(r.root, "a.txt", "changed and stat dirty\n");
		await expect(capture(r, { kind: "local" }, testConfig)).rejects.toThrow(
			"active Git clean/process filters",
		);
		await expect(assertCurrent(snapshot, testConfig)).rejects.toThrow("active Git clean/process filters");
		await expect(access(join(r.root, "filter-ran"))).rejects.toMatchObject({ code: "ENOENT" });
	},
);
it("permits configured filters that do not apply to inspected paths", async () => {
	const r = await repo();
	await put(r.root, "a.txt", "one\n");
	await commit(r.root);
	await testGit(r.root, "config", "filter.unused.clean", "sh -c 'printf ran > filter-ran; cat'");
	await put(r.root, "a.txt", "two\n");
	expect((await capture(r, { kind: "local" }, testConfig)).changes[0]?.added).toEqual(["two"]);
	await expect(access(join(r.root, "filter-ran"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("stops file reads at the search match cap and leaves unread files for the next page", async () => {
	const read = vi.fn(async (file: string) => Buffer.from(file === "a" ? "hit\n".repeat(100) : "later hit\n"));
	const snapshot = { repo: { root: "/fixture" }, paths: () => ["a", "b", "c"], read } as unknown as Snapshot;
	const tool = snapshotTools(snapshot).find((item) => item.name === "search_source")!;
	const result = await tool.execute("fixture", { query: "hit" }, new AbortController().signal);
	const page = JSON.parse((result.content[0] as { text: string }).text);
	expect(page.scanned).toBe(1);
	expect(page.nextOffset).toBe(1);
	expect(page.matches).toHaveLength(100);
	expect(read.mock.calls.map(([file]) => file)).toEqual(["a"]);
	await tool.execute("fixture-2", { query: "hit", offset: page.nextOffset }, new AbortController().signal);
	expect(read.mock.calls.map(([file]) => file)).toEqual(["a", "b", "c"]);
});
it("exposes actual captured mode changes to independent verifiers", async () => {
	const r = await repo();
	await put(r.root, "run.sh", "echo fixture\n");
	await chmod(join(r.root, "run.sh"), 0o755);
	await commit(r.root);
	await chmod(join(r.root, "run.sh"), 0o644);
	const snapshot = await capture(r, { kind: "local" }, testConfig);
	const tool = snapshotTools(snapshot).find((item) => item.name === "read_change")!;
	const result = await tool.execute("fixture", { path: "run.sh" }, new AbortController().signal);
	expect((result.content[0] as { text: string }).text).toContain("old mode 100755\nnew mode 100644");
	expect((await snapshot.read("run.sh")).toString()).toBe(
		(await readFile(join(r.root, "run.sh"))).toString(),
	);
});
