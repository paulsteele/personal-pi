import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { discoverLspFiles } from "./lsp-setup.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function discoveryFixture(files: Record<string, string>) {
	const directory = await mkdtemp(join(tmpdir(), "lsp-discovery-"));
	temporaryDirectories.push(directory);
	const root = join(directory, "project");
	await mkdir(root);
	for (const [file, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, file)), { recursive: true });
		await writeFile(join(root, file), content);
	}
	const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: root });
	return { directory, root, git, signal: new AbortController().signal };
}

it("includes tracked and untracked source, but not ignored caches, deleted files, or symlinks", async () => {
	const fixture = await discoveryFixture({
		".gitignore": "packages/\n",
		"App.sln": "",
		"Source/App.cs": "class App {}",
		"Source/Deleted.cs": "class Deleted {}",
		"Source/Draft\nApp.cs": "class Draft {}",
		"packages/cache/Dependency.cs": "class Dependency {}",
		"packages/workspace/Tracked.cs": "class Tracked {}",
		"obj/Generated.cs": "class Generated {}",
	});
	await fixture.git("init", "-q");
	await fixture.git("add", "App.sln", "Source/App.cs", "Source/Deleted.cs");
	await fixture.git("add", "-f", "packages/workspace/Tracked.cs", "obj/Generated.cs");
	await unlink(join(fixture.root, "Source/Deleted.cs"));
	await writeFile(join(fixture.directory, "Outside.cs"), "class Outside {}");
	await symlink(join(fixture.directory, "Outside.cs"), join(fixture.root, "Source/Linked.cs"));
	await fixture.git("add", "Source/Linked.cs");
	expect(await discoverLspFiles(fixture.root, fixture.signal)).toEqual({
		files: [
			".gitignore",
			"App.sln",
			"Source/App.cs",
			"Source/Draft\nApp.cs",
			"packages/workspace/Tracked.cs",
		],
		truncated: false,
	});
});

it("does not follow a tracked directory replaced by a symlink", async () => {
	const fixture = await discoveryFixture({ "Source/App.cs": "class App {}" });
	await fixture.git("init", "-q");
	await fixture.git("add", "Source/App.cs");
	const externalSource = join(fixture.directory, "external");
	await mkdir(externalSource);
	await writeFile(join(externalSource, "App.cs"), "class External {}");
	await rm(join(fixture.root, "Source"), { recursive: true });
	await symlink(externalSource, join(fixture.root, "Source"));
	expect(await discoverLspFiles(fixture.root, fixture.signal)).toEqual({ files: [], truncated: false });
});

it("keeps Git discovery relative to a nested workspace and excludes sibling source", async () => {
	const fixture = await discoveryFixture({
		"Source/App.cs": "class App {}",
		"Source/New.cs": "class New {}",
		"Sibling/Outside.cs": "class Outside {}",
	});
	await fixture.git("init", "-q");
	await fixture.git("add", "Source/App.cs", "Sibling/Outside.cs");
	expect(await discoverLspFiles(join(fixture.root, "Source"), fixture.signal)).toEqual({
		files: ["App.cs", "New.cs"],
		truncated: false,
	});
});

it.each(["ignored", "tracked", "non-Git"] as const)(
	"finds C# source alongside more than 10,000 %s dependency entries",
	async (dependencyLayout) => {
		const fixture = await discoveryFixture({
			".gitignore": "packages/\n",
			"App.sln": "",
			"Source/App.cs": "class App {}",
		});
		const cache = join(fixture.root, "packages/cache");
		await mkdir(cache, { recursive: true });
		for (let index = 0; index < 10001; index++) {
			await writeFile(join(cache, `dependency-${index}.xml`), "");
		}
		if (dependencyLayout !== "non-Git") {
			await fixture.git("init", "-q");
			await fixture.git("add", "App.sln", "Source/App.cs");
		}
		if (dependencyLayout === "tracked") {
			await fixture.git("add", "-f", "packages");
		}
		const discovery = await discoverLspFiles(fixture.root, fixture.signal);
		expect(discovery.files).toContain("Source/App.cs");
		expect(discovery.files).toContain("App.sln");
		expect(discovery.files).toEqual([...discovery.files].sort());
		expect(discovery.truncated).toBe(dependencyLayout !== "ignored");
		if (dependencyLayout === "ignored") {
			expect(discovery.files).toEqual([".gitignore", "App.sln", "Source/App.cs"]);
		}
	},
	20000,
);

it("honors cancellation before scanning a workspace", async () => {
	const fixture = await discoveryFixture({ "App.cs": "class App {}" });
	const cancellation = new AbortController();
	cancellation.abort(new Error("Discovery cancelled"));
	await expect(discoverLspFiles(fixture.root, cancellation.signal)).rejects.toThrow("Discovery cancelled");
});
