import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { git } from "./git.js";
import { hash } from "./prompts.js";
import type { Repo } from "./types.js";

export const inside = (root: string, path: string): boolean => {
	const rel = relative(root, path);
	return (
		rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"))
	);
};
async function canonical(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return resolve(await canonical(parent), relative(parent, path));
	}
}
export async function storageRoot(agentDir: string, repo: Repo): Promise<string> {
	const root = await canonical(resolve(agentDir, "extensions", "pr-review"));
	if (inside(await canonical(repo.root), root))
		throw new Error("PR runtime storage must be outside the reviewed checkout.");
	return root;
}
export async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing symlink storage directory: ${path}`);
	await chmod(path, 0o700);
}
async function checkPath(root: string, path: string): Promise<void> {
	if (!inside(root, path) || root === path) throw new Error("Invalid runtime storage path");
	let current = path;
	while (current !== root) {
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new Error("Refusing symlink in runtime storage");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		current = dirname(current);
	}
	const ancestor = await nearestExistingDirectory(dirname(path));
	const top = (await git(ancestor, ["rev-parse", "--show-toplevel"], undefined, true))
		.toString()
		.replace(/\r?\n$/, "");
	if (
		top &&
		(await git(top, ["ls-files", "--error-unmatch", "--", relative(top, path)], undefined, true)).length
	) {
		throw new Error("Refusing to write Git-tracked runtime data");
	}
}
async function nearestExistingDirectory(path: string): Promise<string> {
	try {
		await lstat(path);
		return path;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
		return nearestExistingDirectory(dirname(path));
	}
}
export async function initializeStorage(root: string): Promise<void> {
	await ensurePrivateDirectory(root);
	const ignore = join(root, ".gitignore");
	await checkPath(root, ignore);
	try {
		const handle = await open(ignore, "wx", 0o600);
		try {
			await handle.writeFile("*\n");
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const rules = (await readFile(ignore, "utf8"))
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "" && !line.startsWith("#"));
	if (rules.length === 0 || rules.some((line) => line !== "*"))
		throw new Error(
			"Runtime .gitignore must contain only the ignore-all rule (plus blank lines/comments); conflicting rules are refused",
		);
}
export async function readStored(
	root: string,
	path: string,
): Promise<{ value: unknown; revision: string } | undefined> {
	await checkPath(root, path);
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid/oversized runtime file");
		const text = await readFile(path, "utf8");
		return { value: JSON.parse(text) as unknown, revision: hash(text) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
/** Compare-and-swap publication under an exclusive cross-process lock. No stale-lock guessing. */
export async function publish(
	root: string,
	path: string,
	value: unknown,
	expected: string | undefined,
	signal?: AbortSignal,
): Promise<void> {
	await initializeStorage(root);
	await checkPath(root, path);
	await ensurePrivateDirectory(dirname(path));
	await checkPath(root, path);
	const lockPath = `${path}.lock`;
	let lock;
	try {
		lock = await open(lockPath, "wx", 0o600);
	} catch {
		throw new Error(
			`Runtime file is locked: ${lockPath}. Retry after the other operation completes; inspect a stale lock before removing it.`,
		);
	}
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
		if ((await readStored(root, path))?.revision !== expected)
			throw new Error("Runtime data changed since preview; retry setup.");
		signal?.throwIfAborted();
		const serialized = JSON.stringify(value, null, 2);
		if (serialized === undefined || Buffer.byteLength(serialized) > 4 * 1024 * 1024)
			throw new Error("Runtime record exceeds storage budget or is not JSON data");
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(`${serialized}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		signal?.throwIfAborted();
		await rename(temp, path);
	} finally {
		await lock.close();
		await unlink(temp).catch(() => {});
		await unlink(lockPath);
	}
}
export const profilePath = (root: string, repoId: string): string => {
	if (!/^[a-f0-9]{64}$/.test(repoId)) throw new Error("Invalid repository identity");
	return join(root, "repos", repoId, "profile.json");
};
