import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { hash } from "./prompts.js";
import type { Repo, Scope } from "./types.js";

const execute = promisify(execFile);
export async function git(
	cwd: string,
	args: string[],
	signal?: AbortSignal,
	allowFailure: boolean | readonly number[] = false,
	maxBytes = 32 * 1024 * 1024,
	input?: Buffer,
): Promise<Buffer> {
	// Worktree comparisons can invoke clean/process filters even with --no-textconv.
	if (args[0] === "diff" || args[0] === "status") await assertFilterFree(cwd, signal);
	try {
		const pending = execute(
			"git",
			["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
			{
				cwd,
				encoding: "buffer",
				maxBuffer: Math.max(1, maxBytes),
				timeout: 30000,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
				...(signal ? { signal } : {}),
			},
		);
		pending.child.stdin?.on("error", () => {});
		pending.child.stdin?.end(input);
		return (await pending).stdout;
	} catch (error) {
		if (signal?.aborted) throw new Error("Cancelled");
		const code = (error as { code?: unknown }).code;
		if (
			typeof code === "number" &&
			(allowFailure === true || (Array.isArray(allowFailure) && allowFailure.includes(code)))
		)
			return Buffer.alloc(0);
		throw new Error(`Git ${args[0]} failed; check repository state, refs, and available local objects.`, {
			cause: error,
		});
	}
}
async function assertFilterFree(cwd: string, signal?: AbortSignal): Promise<void> {
	const configuration = await git(
		cwd,
		["config", "--null", "--get-regexp", "^filter\\..*\\.(clean|process)$"],
		signal,
		[1],
	);
	const effective = new Map<string, string>();
	for (const entry of configuration.toString("utf8").split("\0")) {
		if (!entry) continue;
		const separator = entry.indexOf("\n");
		if (separator < 0) throw new Error("Cannot establish filter-free Git inspection");
		effective.set(entry.slice(0, separator), entry.slice(separator + 1));
	}
	const drivers = new Set<string>();
	for (const [name, value] of effective) {
		const driver = name.match(/^filter\.(.*)\.(?:clean|process)$/)?.[1];
		if (!driver) throw new Error("Cannot establish filter-free Git inspection");
		if (value.trim()) drivers.add(driver);
	}
	if (!drivers.size) return;
	// Attribute queries and index listing do not execute conversion filters. Inspect both
	// current and staged attributes; global-but-unused filters must not block every repo.
	const names = await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], signal);
	if (!names.length) return;
	for (const cached of [false, true]) {
		const attributes = await git(
			cwd,
			["check-attr", ...(cached ? ["--cached"] : []), "-z", "--stdin", "filter"],
			signal,
			false,
			undefined,
			names,
		);
		const fields = attributes.toString("utf8").split("\0");
		if (fields.pop() !== "" || fields.length % 3 !== 0)
			throw new Error("Cannot establish filter-free Git attributes");
		for (let i = 0; i < fields.length; i += 3)
			if (drivers.has(fields[i + 2]!))
				throw new Error(
					"Review capture refuses active Git clean/process filters on source paths. Use a filter-free review configuration; no filter commands were executed.",
				);
	}
}
const line = (value: Buffer) => value.toString("utf8").replace(/\r?\n$/, "");

/** Raw commit headers preserve parent information even at a shallow boundary. */
export async function firstParent(root: string, head: string, signal?: AbortSignal): Promise<string | null> {
	const header = (await git(root, ["cat-file", "commit", head], signal))
		.toString("utf8")
		.split("\n\n", 1)[0]!;
	if (!/^tree (?:[a-f0-9]{40}|[a-f0-9]{64})$/m.test(header)) throw new Error("Invalid HEAD commit metadata");
	const parent = header.match(/^parent ((?:[a-f0-9]{40}|[a-f0-9]{64}))$/m)?.[1];
	if (!parent) return null;
	try {
		return await resolveCommit(root, parent, signal);
	} catch (error) {
		throw new Error(
			"First-parent history is unavailable locally; cannot review the latest commit. No history was fetched.",
			{ cause: error },
		);
	}
}
export async function resolveRepo(cwd: string, signal?: AbortSignal): Promise<Repo> {
	const root = await realpath(line(await git(cwd, ["rev-parse", "--show-toplevel"], signal)));
	const commonDir = await realpath(
		line(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)),
	);
	return { root, commonDir, id: hash(commonDir) };
}
export async function resolveCommit(
	root: string,
	ref: string,
	signal?: AbortSignal,
	optional = false,
): Promise<string | null> {
	const value = line(
		await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], signal, optional),
	);
	if (!value && optional) return null;
	if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid or unavailable commit: ${ref}`);
	return value;
}
export function parseScope(args: string): Scope {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const committedOnly = words.includes("--committed-only");
	const filtered = words.filter((word) => word !== "--committed-only");
	if (words.filter((word) => word === "--committed-only").length > 1)
		throw new Error("Duplicate --committed-only");
	if (filtered.length === 0 && !committedOnly) return { kind: "local" };
	if (filtered.length === 1 && filtered[0] === "--base")
		throw new Error("Missing base reference. Use /pr --base main (or another branch/ref).");
	if (filtered.length === 2 && filtered[0] === "--commits" && /^[1-9]\d*$/.test(filtered[1]!)) {
		const count = Number(filtered[1]);
		if (Number.isSafeInteger(count) && count <= 10000) return { kind: "commits", count, committedOnly };
	}
	if (filtered.length === 2 && filtered[0] === "--base" && !filtered[1]!.startsWith("-"))
		return { kind: "base", ref: filtered[1]!, committedOnly };
	throw new Error("Usage: /pr [--commits N | --base REF] [--committed-only]");
}
