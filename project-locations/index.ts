import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

export interface GitRepositoryLocation {
	id: string;
	root: string;
	commonDir: string;
}

export interface ProjectLocation {
	id: string;
	kind: "repos" | "projects";
	root: string;
}

export type GitLocationRunner = (cwd: string, args: string[], signal?: AbortSignal) => Promise<string>;

const execute = promisify(execFile);

export const runGitLocationQuery: GitLocationRunner = async (cwd, args, signal) => {
	const result = await execute(
		"git",
		["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
		{
			cwd,
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
			signal,
		},
	);
	return result.stdout;
};

export function projectIdentity(canonicalIdentityPath: string): string {
	return createHash("sha256").update(canonicalIdentityPath).digest("hex");
}

function gitOutputPath(output: string): string {
	return output.replace(/\r?\n$/, "");
}

export async function resolveGitRepository(
	cwd: string,
	options: { git?: GitLocationRunner; signal?: AbortSignal } = {},
): Promise<GitRepositoryLocation> {
	const canonicalCwd = await realpath(cwd);
	const git = options.git ?? runGitLocationQuery;
	options.signal?.throwIfAborted();
	const root = await realpath(
		gitOutputPath(await git(canonicalCwd, ["rev-parse", "--show-toplevel"], options.signal)),
	);
	const commonDir = await realpath(
		gitOutputPath(
			await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], options.signal),
		),
	);
	options.signal?.throwIfAborted();
	return { root, commonDir, id: projectIdentity(commonDir) };
}

function canFallBackToProjectDirectory(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "ENOENT" || code === 128;
}

export async function resolveProjectLocation(
	cwd: string,
	options: {
		git?: GitLocationRunner;
		signal?: AbortSignal;
		hasProfile?: (project: ProjectLocation) => Promise<boolean>;
	} = {},
): Promise<ProjectLocation> {
	const canonicalCwd = await realpath(cwd);
	try {
		const repository = await resolveGitRepository(canonicalCwd, options);
		return { kind: "repos", root: repository.root, id: repository.id };
	} catch (error) {
		options.signal?.throwIfAborted();
		if (!canFallBackToProjectDirectory(error)) {
			throw error;
		}
	}
	for (let root = canonicalCwd; ; root = dirname(root)) {
		options.signal?.throwIfAborted();
		const project: ProjectLocation = { kind: "projects", root, id: projectIdentity(root) };
		if (await options.hasProfile?.(project)) {
			return project;
		}
		if (dirname(root) === root) {
			break;
		}
	}
	return { kind: "projects", root: canonicalCwd, id: projectIdentity(canonicalCwd) };
}

export function projectStoragePath(
	storageRoot: string,
	project: Pick<ProjectLocation, "kind" | "id">,
	profilePath: string,
): string {
	if (!/^[a-f0-9]{64}$/.test(project.id) || !["repos", "projects"].includes(project.kind)) {
		throw new Error("Invalid private project identity");
	}
	if (!profilePath || isAbsolute(profilePath) || profilePath.includes("\0") || profilePath.includes("\\")) {
		throw new Error("Expected a relative private profile path");
	}
	const directory = resolve(storageRoot, project.kind, project.id);
	const path = join(directory, profilePath);
	const offset = relative(directory, path);
	if (!offset || offset === ".." || offset.startsWith("../") || isAbsolute(offset)) {
		throw new Error("Private profile path escapes its project directory");
	}
	return path;
}
