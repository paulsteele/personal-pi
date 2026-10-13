import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { capture, fixture, put, testConfig, testGit } from "./test-fixtures.js";

const pointer = (digit: string) =>
	`version https://git-lfs.github.com/spec/v1\noid sha256:${digit.repeat(64)}\nsize 12345\n`;
const filterCommand = "sh -c 'printf ran > .git/lfs-filter-ran; exit 1'";

it("captures an unborn LFS repository without reading staged or untracked assets", async () => {
	const repo = await fixture();
	let snapshot: Awaited<ReturnType<typeof capture>> | undefined;
	try {
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
		for (const kind of ["clean", "process", "smudge"]) {
			await testGit(repo.root, "config", `filter.lfs.${kind}`, filterCommand);
		}
		await testGit(repo.root, "config", "filter.lfs.required", "true");
		snapshot = await capture(repo, { kind: "local" }, testConfig);
		expect(snapshot.head).toBeNull();
		expect(snapshot.baseline).toBeNull();
		expect(snapshot.changes.map((change) => change.file)).toEqual([".gitattributes", "a.ts"]);
		expect(snapshot.changes.find((change) => change.file === "a.ts")?.added).toEqual(["new code"]);
		expect(snapshot.omitted.map((item) => item.file)).toEqual(["staged.png", "untracked.png"]);
		expect(snapshot.paths()).toEqual([".gitattributes", "a.ts"]);
		await expect(access(join(repo.root, ".git/lfs-filter-ran"))).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await snapshot?.dispose?.();
		await rm(repo.root, { recursive: true, force: true });
	}
});
