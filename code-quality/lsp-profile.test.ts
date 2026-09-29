import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
	approveLspDraft,
	loadLspDraft,
	loadLspProfile,
	lspProfilePath,
	matchingLspRoutes,
	parseLspProfile,
	resolveLspProject,
	saveLspDraft,
	type LspProfile,
	type LspRoute,
} from "./lsp-profile.js";

const directories: string[] = [];
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

function route(id = "typescript", root = "."): LspRoute {
	return {
		id,
		root,
		preset: "typescript",
		command: "/tools/typescript-language-server",
		args: ["--stdio"],
		version: "6.0.1",
		extensions: { ".ts": "typescript" },
		env: {},
		settings: {},
		initializationOptions: {},
		startupTimeoutMs: 60000,
		diagnosticTimeoutMs: 10000,
	};
}
async function projectFixture() {
	const directory = await mkdtemp(join(tmpdir(), "lsp-profile-"));
	directories.push(directory);
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	await mkdir(cwd);
	const project = await resolveLspProject(cwd, agentDir);
	const profile: LspProfile = { version: 1, projectId: project.id, enabled: true, routes: [route()] };
	return { directory, cwd, agentDir, project, profile };
}

it("keeps drafts inactive until their exact revision is approved", async () => {
	const { agentDir, project, profile } = await projectFixture();
	await saveLspDraft(agentDir, project, profile);
	expect(await loadLspProfile(agentDir, project)).toBeUndefined();
	const draft = (await loadLspDraft(agentDir, project))!;
	const saved = await approveLspDraft(agentDir, project, draft.revision);
	expect(saved.profile).toEqual(profile);
	expect((await loadLspProfile(agentDir, project))?.revision).toBe(saved.revision);
	await expect(approveLspDraft(agentDir, project, draft.revision)).rejects.toThrow("changed since preview");
});

it("rejects a draft saved from an outdated setup preview", async () => {
	const { agentDir, project, profile } = await projectFixture();
	await saveLspDraft(agentDir, project, profile);
	const original = (await loadLspDraft(agentDir, project))!;
	await saveLspDraft(agentDir, project, { ...profile, enabled: false }, null, original.revision);
	await expect(saveLspDraft(agentDir, project, profile, null, original.revision)).rejects.toThrow(
		"changed since preview",
	);
	expect((await loadLspDraft(agentDir, project))!.draft.profile.enabled).toBe(false);
});

it("rejects manual active-profile changes instead of executing them", async () => {
	const { agentDir, project, profile } = await projectFixture();
	await saveLspDraft(agentDir, project, profile);
	await approveLspDraft(agentDir, project, (await loadLspDraft(agentDir, project))!.revision);
	const path = lspProfilePath(agentDir, project);
	const stored = JSON.parse(await readFile(path, "utf8"));
	stored.profile.routes[0].command = "/unapproved/server";
	await writeFile(path, JSON.stringify(stored));
	await expect(loadLspProfile(agentDir, project)).rejects.toThrow("outside approval");
});

it("allows only one simultaneous approval of the same draft", async () => {
	const { agentDir, project, profile } = await projectFixture();
	await saveLspDraft(agentDir, project, profile);
	const revision = (await loadLspDraft(agentDir, project))!.revision;
	const attempts = await Promise.allSettled([
		approveLspDraft(agentDir, project, revision),
		approveLspDraft(agentDir, project, revision),
	]);
	expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
	expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
});

it("resolves configured non-Git ancestors and routes to the deepest matching workspace", async () => {
	const { cwd, agentDir, project, profile } = await projectFixture();
	await mkdir(join(cwd, "frontend/src"), { recursive: true });
	profile.routes.push(route("frontend", "frontend"), route("frontend-extra", "frontend"));
	await saveLspDraft(agentDir, project, profile);
	await approveLspDraft(agentDir, project, (await loadLspDraft(agentDir, project))!.revision);
	expect(await resolveLspProject(join(cwd, "frontend/src"), agentDir)).toEqual(project);
	expect(
		matchingLspRoutes(profile, project, join(project.root, "frontend/src/file.ts")).map((route) => route.id),
	).toEqual(["frontend", "frontend-extra"]);
	expect(matchingLspRoutes(profile, project, join(project.root, "file.py"))).toEqual([]);
	expect(matchingLspRoutes({ ...profile, enabled: false }, project, join(project.root, "file.ts"))).toEqual(
		[],
	);
});

it("shares the PR-style identity across Git worktrees but keeps physical roots distinct", async () => {
	const { cwd, directory, agentDir } = await projectFixture();
	const git = (args: string[]) => promisify(execFile)("git", args, { cwd });
	await git(["init", "-q"]);
	await git([
		"-c",
		"user.email=test@example.com",
		"-c",
		"user.name=Test",
		"commit",
		"--allow-empty",
		"-qm",
		"initial",
	]);
	const worktree = join(directory, "worktree");
	await git(["worktree", "add", "-b", "other", worktree]);
	const main = await resolveLspProject(cwd, agentDir);
	const other = await resolveLspProject(worktree, agentDir);
	expect(other.id).toBe(main.id);
	expect(other.root).not.toBe(main.root);
	expect(lspProfilePath(agentDir, main)).toBe(lspProfilePath(agentDir, other));
});

it("rejects unsupported profiles, traversal, duplicate routes, and native Roslyn daemon mode", async () => {
	const { project, profile } = await projectFixture();
	expect(() => parseLspProfile({ ...profile, unexpected: true }, project.id)).toThrow();
	expect(() =>
		parseLspProfile({ ...profile, routes: [route("typescript", "../outside")] }, project.id),
	).toThrow("traversal");
	expect(() => parseLspProfile({ ...profile, routes: [{ ...route(), args: ["\0"] }] }, project.id)).toThrow(
		"null byte",
	);
	expect(() =>
		parseLspProfile(
			{ ...profile, routes: [{ ...route(), preset: "roslyn", args: ["--daemon-mode"] }] },
			project.id,
		),
	).toThrow("daemon mode");
	expect(() => parseLspProfile({ ...profile, routes: [route(), route()] }, project.id)).toThrow("Duplicate");
});

it("refuses a symlinked private storage ancestor", async () => {
	const { directory, agentDir, project, profile } = await projectFixture();
	await mkdir(agentDir);
	const outside = join(directory, "outside");
	await mkdir(outside);
	await symlink(outside, join(agentDir, "extensions"));
	await expect(saveLspDraft(agentDir, project, profile)).rejects.toThrow("symlink");
});
