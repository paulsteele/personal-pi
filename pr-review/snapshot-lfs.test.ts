import { access, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { git, parseScope } from "./git.js";
import { capture as captureSource, snapshotTools } from "./snapshot.js";
import { capture, commit, fixture, put, testAccess, testConfig, testGit } from "./test-fixtures.js";
import type { Repo } from "./types.js";

const roots: string[] = [];
const pointer = (digit: string) =>
	`version https://git-lfs.github.com/spec/v1\noid sha256:${digit.repeat(64)}\nsize 12345\n`;
const filterCommand = "sh -c 'printf ran > .git/lfs-filter-ran; exit 1'";
async function lfsRepo() {
	const repo = await fixture();
	roots.push(repo.root);
	for (const kind of ["clean", "process", "smudge"]) {
		await testGit(repo.root, "config", `filter.lfs.${kind}`, "");
	}
	await testGit(repo.root, "config", "filter.lfs.required", "false");
	await put(repo.root, ".gitattributes", "*.png filter=lfs diff=lfs merge=lfs -text\n");
	await put(repo.root, "snapshot.png", pointer("a"));
	await put(repo.root, "a.ts", "original\n");
	await commit(repo.root);
	return repo;
}
async function armLfsFilters(repo: Repo) {
	for (const kind of ["clean", "process", "smudge"]) {
		await testGit(repo.root, "config", `filter.lfs.${kind}`, filterCommand);
	}
	await testGit(repo.root, "config", "filter.lfs.required", "true");
}
afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

it.each(["clean", "process", "smudge"])(
	"captures final code beside a materialized LFS asset without running the %s filter",
	async (kind) => {
		const repo = await lfsRepo();
		await put(repo.root, "a.ts", "staged\n");
		await testGit(repo.root, "add", "a.ts");
		await put(repo.root, "a.ts", "final\n");
		await put(repo.root, "snapshot.png", Buffer.from([0, 1, 2, 3]));
		await testGit(repo.root, "config", `filter.lfs.${kind}`, filterCommand);
		await testGit(repo.root, "config", "filter.lfs.required", "true");
		const index = await testGit(repo.root, "ls-files", "--stage");
		const configuration = await testGit(repo.root, "config", "--local", "--list");
		const asset = await readFile(join(repo.root, "snapshot.png"));
		const snapshot = await capture(repo, { kind: "local" }, testConfig);
		try {
			expect(snapshot.changes.map((change) => change.file)).toEqual(["a.ts"]);
			expect(snapshot.changes[0]?.added).toEqual(["final"]);
			expect(snapshot.changes[0]?.removed).toEqual(["original"]);
			expect(snapshot.omitted).toEqual([
				{ file: "snapshot.png", reason: "excluded: Git LFS content (not text-reviewed)" },
			]);
			expect(snapshot.paths()).not.toContain("snapshot.png");
			await expect(snapshot.read("snapshot.png")).rejects.toThrow("Git LFS content");
			await expect(snapshot.read("snapshot.png", "old")).rejects.toThrow("Git LFS content");
			await snapshot.validateCurrent?.();
			expect(await testGit(repo.root, "ls-files", "--stage")).toBe(index);
			expect(await testGit(repo.root, "config", "--local", "--list")).toBe(configuration);
			expect(await readFile(join(repo.root, "snapshot.png"))).toEqual(asset);
			await expect(access(join(repo.root, ".git/lfs-filter-ran"))).rejects.toMatchObject({ code: "ENOENT" });
			await put(repo.root, "a.ts", "later\n");
			await expect(snapshot.validateCurrent?.()).rejects.toThrow("Source changed");
		} finally {
			await snapshot.dispose?.();
		}
	},
);

it.each(["modified", "deleted", "renamed", "untracked", "pointer"])(
	"excludes %s LFS content while keeping code reviewable",
	async (state) => {
		const repo = await lfsRepo();
		await put(repo.root, "a.ts", "changed\n");
		if (state === "deleted") {
			await rm(join(repo.root, "snapshot.png"));
		} else if (state === "renamed") {
			await rename(join(repo.root, "snapshot.png"), join(repo.root, "new snapshot\tline\n.png"));
		} else if (state === "untracked") {
			await put(repo.root, "new.png", Buffer.from([0, 9, 8]));
		} else {
			await put(repo.root, "snapshot.png", state === "pointer" ? pointer("b") : Buffer.from([0, 9, 8]));
		}
		await armLfsFilters(repo);
		const snapshot = await capture(repo, { kind: "local" }, testConfig);
		try {
			expect(snapshot.changes.map((change) => change.file)).toEqual(["a.ts"]);
			expect(snapshot.omitted.length).toBeGreaterThan(0);
			expect(snapshot.omitted.every((item) => item.reason.startsWith("excluded: Git LFS"))).toBe(true);
			expect(snapshot.paths().some((path) => path.endsWith(".png"))).toBe(false);
			await expect(access(join(repo.root, ".git/lfs-filter-ran"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await snapshot.dispose?.();
		}
	},
);

it.each(["materialized", "pointer", "asset-only edit"])(
	"falls back to the latest code commit with a %s LFS asset",
	async (state) => {
		const repo = await lfsRepo();
		const parent = (await testGit(repo.root, "rev-parse", "HEAD")).trim();
		await put(repo.root, "a.ts", "committed\n");
		await commit(repo.root);
		if (state !== "pointer") {
			await put(repo.root, "snapshot.png", Buffer.from(state === "materialized" ? [0, 1] : [0, 7, 8, 9]));
		}
		await armLfsFilters(repo);
		const snapshot = await capture(repo, { kind: "local" }, testConfig);
		try {
			expect(snapshot.baseline).toBe(parent);
			expect(snapshot.changes.map((change) => change.file)).toEqual(["a.ts"]);
			expect(snapshot.changes[0]?.added).toEqual(["committed"]);
			await expect(access(join(repo.root, ".git/lfs-filter-ran"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await snapshot.dispose?.();
		}
	},
);

it("does not mistake a staged code revert for a clean checkout beside LFS", async () => {
	const repo = await lfsRepo();
	const head = (await testGit(repo.root, "rev-parse", "HEAD")).trim();
	await put(repo.root, "a.ts", "staged\n");
	await testGit(repo.root, "add", "a.ts");
	await put(repo.root, "a.ts", "original\n");
	await put(repo.root, "snapshot.png", Buffer.from([0, 1]));
	await armLfsFilters(repo);
	const snapshot = await capture(repo, { kind: "local" }, testConfig);
	try {
		expect(snapshot.baseline).toBe(head);
		expect(snapshot.changes).toEqual([]);
		await expect(access(join(repo.root, ".git/lfs-filter-ran"))).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await snapshot.dispose?.();
	}
});

it.each(["--commits 1 --committed-only", "--base main --committed-only", "--base main"])(
	"uses historical LFS attributes for %s even after the rules are removed",
	async (scope) => {
		const repo = await lfsRepo();
		await testGit(repo.root, "checkout", "-b", "feature");
		await rm(join(repo.root, ".gitattributes"));
		await rm(join(repo.root, "snapshot.png"));
		await put(repo.root, "a.ts", "committed\n");
		await commit(repo.root);
		await put(repo.root, "a.ts", "local\n");
		await armLfsFilters(repo);
		const snapshot = await capture(repo, parseScope(scope), testConfig);
		try {
			expect(snapshot.changes.map((change) => change.file)).toEqual([".gitattributes", "a.ts"]);
			expect(snapshot.changes.find((change) => change.file === "a.ts")?.added).toEqual([
				scope.includes("--committed-only") ? "committed" : "local",
			]);
			expect(snapshot.omitted).toContainEqual({
				file: "snapshot.png",
				reason: "excluded: Git LFS content (not text-reviewed)",
			});
			await expect(snapshot.read("snapshot.png", "old")).rejects.toThrow("Git LFS content");
			await expect(access(join(repo.root, ".git/lfs-filter-ran"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await snapshot.dispose?.();
		}
	},
);

it("honors staged LFS rules when working attributes no longer select LFS", async () => {
	const repo = await lfsRepo();
	await testGit(repo.root, "add", ".gitattributes");
	await put(repo.root, ".gitattributes", "*.png -filter\n");
	await put(repo.root, "new.png", "asset payload is not source\n");
	await put(repo.root, "a.ts", "changed\n");
	await armLfsFilters(repo);
	const snapshot = await capture(repo, { kind: "local" }, testConfig);
	try {
		expect(snapshot.changes.map((change) => change.file)).toEqual([".gitattributes", "a.ts"]);
		expect(snapshot.paths()).not.toContain("new.png");
		await expect(snapshot.read("new.png")).rejects.toThrow("Git LFS content");
		await expect(access(join(repo.root, ".git/lfs-filter-ran"))).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await snapshot.dispose?.();
	}
});

it("captures an unborn LFS repository without reading staged or untracked assets", async () => {
	const repo = await fixture();
	roots.push(repo.root);
	await put(repo.root, ".gitattributes", "*.png filter=lfs -text\n");
	await put(repo.root, "staged.png", pointer("a"));
	await testGit(
		repo.root,
		"-c",
		"filter.lfs.clean=",
		"-c",
		"filter.lfs.process=",
		"-c",
		"filter.lfs.required=false",
		"add",
		".gitattributes",
		"staged.png",
	);
	await put(repo.root, "staged.png", Buffer.from([0, 1, 2]));
	await put(repo.root, "untracked.png", pointer("b"));
	await put(repo.root, "a.ts", "new code\n");
	await armLfsFilters(repo);
	const snapshot = await capture(repo, { kind: "local" }, testConfig);
	try {
		expect(snapshot.head).toBeNull();
		expect(snapshot.baseline).toBeNull();
		expect(snapshot.changes.map((change) => change.file)).toEqual([".gitattributes", "a.ts"]);
		expect(snapshot.changes.find((change) => change.file === "a.ts")?.added).toEqual(["new code"]);
		expect(snapshot.omitted.map((item) => item.file)).toEqual(["staged.png", "untracked.png"]);
		expect(snapshot.paths()).toEqual([".gitattributes", "a.ts"]);
		await expect(access(join(repo.root, ".git/lfs-filter-ran"))).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await snapshot.dispose?.();
	}
});

it("keeps non-LFS active filters blocked alongside LFS", async () => {
	const repo = await lfsRepo();
	await put(repo.root, ".gitattributes", "*.png filter=lfs\n*.ts filter=probe\n");
	await put(repo.root, "a.ts", "dirty code\n");
	await armLfsFilters(repo);
	await testGit(repo.root, "config", "filter.probe.clean", filterCommand);
	await expect(capture(repo, { kind: "local" }, testConfig)).rejects.toThrow(
		"active Git clean/process filters",
	);
	await expect(git(repo.root, ["status", "--porcelain"])).rejects.toThrow("active Git clean/process filters");
	await expect(access(join(repo.root, ".git/lfs-filter-ran"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("never requests LFS payload access during review or setup discovery", async () => {
	const repo = await lfsRepo();
	await put(repo.root, "snapshot.png", "materialized text asset\n");
	await put(repo.root, "a.ts", "changed\n");
	await armLfsFilters(repo);
	const checkedPaths: string[] = [];
	const permissions = testAccess(async (action) => {
		checkedPaths.push(...(action.effects ?? []).map((effect) => effect.path));
		return { kind: "allowed", revision: "fixture" };
	});
	for (const discovery of [false, true]) {
		const snapshot = await captureSource(
			repo,
			{ kind: "local" },
			testConfig,
			permissions,
			[],
			undefined,
			discovery,
		);
		try {
			expect(snapshot.paths()).toContain("a.ts");
			expect(snapshot.paths()).not.toContain("snapshot.png");
			const tools = snapshotTools(snapshot);
			const search = await tools
				.find((tool) => tool.name === "search_source")!
				.execute("search", { query: "materialized" }, new AbortController().signal);
			expect(JSON.stringify(search.content)).not.toContain("materialized text asset");
			expect(checkedPaths).not.toContain(join(repo.root, "snapshot.png"));
			await expect(access(join(repo.root, ".git/lfs-filter-ran"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await snapshot.dispose?.();
		}
	}
});
