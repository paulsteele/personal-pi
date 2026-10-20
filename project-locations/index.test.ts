import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	projectIdentity,
	projectStoragePath,
	resolveGitRepository,
	resolveProjectLocation,
	type GitLocationRunner,
} from "./index.js";

import { runFixtureGit } from "../tests/git-fixture.js";
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
	directories.length = 0;
});

async function projectFixture() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-project-locations-")));
	directories.push(directory);
	const root = join(directory, "checkout");
	await mkdir(root);
	return { directory, root };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	await runFixtureGit(cwd, args);
}

async function initializeRepository(root: string): Promise<void> {
	await git(root, "init", "-q");
	await git(root, "commit", "--allow-empty", "-qm", "initial");
}

it("shares the canonical common-directory identity across linked worktrees, not clones", async () => {
	const { directory, root } = await projectFixture();
	await initializeRepository(root);
	const worktree = join(directory, "linked");
	const clone = join(directory, "clone");
	await git(root, "worktree", "add", "--detach", worktree);
	await git(directory, "clone", "--local", root, clone);
	const main = await resolveGitRepository(root);
	const linked = await resolveGitRepository(worktree);
	const cloned = await resolveGitRepository(clone);
	const commonDir = await realpath(join(root, ".git"));
	expect(main).toEqual({ root, commonDir, id: createHash("sha256").update(commonDir).digest("hex") });
	expect(linked.id).toBe(main.id);
	expect(linked.commonDir).toBe(commonDir);
	expect(linked.root).toBe(worktree);
	expect(cloned.id).not.toBe(main.id);
	expect(cloned.root).toBe(clone);
});

it("creates worktrees and clones without inheriting developer Git identity, hooks, or signing", async () => {
	const { directory, root } = await projectFixture();
	const hooks = join(directory, "hooks");
	await mkdir(hooks);
	const postCheckout = join(hooks, "post-checkout");
	await writeFile(postCheckout, "#!/bin/sh\nexit 88\n");
	await chmod(postCheckout, 0o700);
	await writeFile(
		join(directory, ".gitconfig"),
		[
			"[user]",
			"\tuseConfigOnly = true",
			"[commit]",
			"\tgpgsign = true",
			"[core]",
			`\thooksPath = ${JSON.stringify(hooks)}`,
			"[init]",
			"\tdefaultBranch = developer-branch",
		].join("\n"),
	);
	const environment = {
		...process.env,
		HOME: directory,
		XDG_CONFIG_HOME: directory,
		GIT_DIR: join(directory, "wrong-repository"),
		GIT_WORK_TREE: join(directory, "wrong-checkout"),
		GIT_INDEX_FILE: join(directory, "wrong-index"),
		GIT_AUTHOR_NAME: "Developer",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: hooks,
	};
	const worktree = join(directory, "linked");
	const clone = join(directory, "clone");
	await runFixtureGit(root, ["init", "--quiet"], { environment });
	await runFixtureGit(root, ["commit", "--allow-empty", "-qm", "initial"], { environment });
	await runFixtureGit(root, ["worktree", "add", "--detach", worktree], { environment });
	await runFixtureGit(directory, ["clone", "--local", root, clone], { environment });
	expect(await runFixtureGit(root, ["log", "-1", "--format=%an <%ae>"], { environment })).toBe(
		"Test <test@example.invalid>\n",
	);
	expect(await runFixtureGit(root, ["branch", "--show-current"], { environment })).toBe("main\n");
	const main = await resolveGitRepository(root);
	expect((await resolveGitRepository(worktree)).id).toBe(main.id);
	expect((await resolveGitRepository(clone)).id).not.toBe(main.id);
});

it("resolves a symlinked startup subdirectory without changing the checkout identity", async () => {
	const { directory, root } = await projectFixture();
	await initializeRepository(root);
	await mkdir(join(root, "src"));
	const alias = join(directory, "alias");
	await symlink(root, alias);
	expect(await resolveGitRepository(join(alias, "src"))).toEqual(await resolveGitRepository(root));
});

it("runs discovery through the supplied hardened Git runner at canonical paths", async () => {
	const { root } = await projectFixture();
	await initializeRepository(root);
	await mkdir(join(root, "src"));
	const calls: { cwd: string; args: string[] }[] = [];
	const runner: GitLocationRunner = async (cwd, args) => {
		calls.push({ cwd, args });
		return runFixtureGit(cwd, args);
	};
	const repository = await resolveGitRepository(join(root, "src"), { git: runner });
	expect(calls).toEqual([
		{ cwd: join(root, "src"), args: ["rev-parse", "--show-toplevel"] },
		{ cwd: root, args: ["rev-parse", "--path-format=absolute", "--git-common-dir"] },
	]);
	expect(repository.root).toBe(root);
});

it("selects the closest caller-configured non-Git ancestor", async () => {
	const { root } = await projectFixture();
	const nested = join(root, "frontend");
	const startup = join(nested, "src");
	await mkdir(startup, { recursive: true });
	const visited: string[] = [];
	const project = await resolveProjectLocation(startup, {
		hasProfile: async (candidate) => {
			visited.push(candidate.root);
			return candidate.root === root || candidate.root === nested;
		},
	});
	expect(project).toEqual({ kind: "projects", root: nested, id: projectIdentity(nested) });
	expect(visited).toEqual([startup, nested]);
});

it("uses the canonical non-Git startup directory when no ancestor is configured", async () => {
	const { directory, root } = await projectFixture();
	const alias = join(directory, "alias");
	await symlink(root, alias);
	const visited: string[] = [];
	const project = await resolveProjectLocation(alias, {
		hasProfile: async (candidate) => {
			visited.push(candidate.root);
			return false;
		},
	});
	expect(project).toEqual({ kind: "projects", root, id: projectIdentity(root) });
	expect(visited[0]).toBe(root);
	expect(dirname(visited.at(-1)!)).toBe(visited.at(-1));
});

it.each(["ENOENT", 128])("falls back when Git discovery reports %s", async (code) => {
	const { root } = await projectFixture();
	const project = await resolveProjectLocation(root, {
		git: async () => {
			throw Object.assign(new Error("Git discovery unavailable"), { code });
		},
	});
	expect(project).toEqual({ kind: "projects", root, id: projectIdentity(root) });
});

it("does not turn a Git execution failure into a different project identity", async () => {
	const { root } = await projectFixture();
	await expect(
		resolveProjectLocation(root, {
			git: async () => {
				throw Object.assign(new Error("Access denied"), { code: "EACCES" });
			},
		}),
	).rejects.toThrow("Access denied");
});

it("preserves cancellation instead of falling back to a non-Git identity", async () => {
	const { root } = await projectFixture();
	const controller = new AbortController();
	controller.abort(new Error("Cancelled discovery"));
	await expect(resolveProjectLocation(root, { signal: controller.signal })).rejects.toThrow(
		"Cancelled discovery",
	);
});

it("preserves existing PR and LSP private profile path layouts", () => {
	const id = projectIdentity("/repo/.git");
	const project = { kind: "repos" as const, id };
	expect(projectStoragePath("/agent/extensions/pr-review", project, "profile.json")).toBe(
		`/agent/extensions/pr-review/repos/${id}/profile.json`,
	);
	expect(projectStoragePath("/agent/extensions/code-quality", project, "lsp-profile.json")).toBe(
		`/agent/extensions/code-quality/repos/${id}/lsp-profile.json`,
	);
	expect(
		projectStoragePath("/agent/extensions/code-quality", { kind: "projects", id }, "lsp-profile-draft.json"),
	).toBe(`/agent/extensions/code-quality/projects/${id}/lsp-profile-draft.json`);
	expect(
		projectStoragePath(
			"/agent/extensions/pi-devcontainer-sandbox",
			project,
			"devcontainer/devcontainer.json",
		),
	).toBe(`/agent/extensions/pi-devcontainer-sandbox/repos/${id}/devcontainer/devcontainer.json`);
});

it.each(["", "/outside.json", "../outside.json", "../../outside.json", "a\0b", "a\\b", "."])(
	"rejects invalid private profile path %j",
	(path) => {
		expect(() => projectStoragePath("/private", { kind: "repos", id: "a".repeat(64) }, path)).toThrow();
	},
);

it("rejects malformed project identities", () => {
	expect(() => projectStoragePath("/private", { kind: "repos", id: "../outside" }, "profile.json")).toThrow(
		"identity",
	);
});
