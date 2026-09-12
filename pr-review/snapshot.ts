import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, join, matchesGlob } from "node:path";
import { structuredPatch } from "diff";
import { createReadTool, truncateHead } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";
import { firstParent, git, resolveCommit } from "./git.js";
import { BlobCache } from "./blob-cache.js";
import { safePath } from "./profile.js";
import { hash } from "./prompts.js";
import { inside } from "./storage.js";
import type { Config, Repo, Scope } from "./types.js";

type Entry = { mode: string; oid: string; data?: Buffer; unavailable?: string };
export interface Change {
	file: string;
	oldPath: string;
	patch: string;
	added: string[];
	removed: string[];
	oldLines: Set<number>;
	newLines: Set<number>;
	metadataOnly: boolean;
}
export interface Snapshot {
	repo: Repo;
	head: string | null;
	baseline: string | null;
	fingerprint: string;
	changes: Change[];
	omitted: Array<{ file: string; reason: string }>;
	read(path: string, side?: "old" | "new"): Promise<Buffer>;
	paths(side?: "old" | "new"): string[];
}
const blobId = (data: Buffer, length: number) =>
	createHash(length === 64 ? "sha256" : "sha1")
		.update(`blob ${data.length}\0`)
		.update(data)
		.digest("hex");
async function tree(repo: Repo, ref: string | null, signal?: AbortSignal): Promise<Map<string, Entry>> {
	const result = new Map<string, Entry>();
	if (!ref) return result;
	for (const row of (await git(repo.root, ["ls-tree", "-r", "-z", "--full-tree", ref], signal))
		.toString("utf8")
		.split("\0")) {
		if (!row) continue;
		const tab = row.indexOf("\t");
		const [mode, , oid] = row.slice(0, tab).split(" ");
		const path = safePath(row.slice(tab + 1));
		if (!mode || !oid || tab < 0) throw new Error("Invalid Git tree data");
		result.set(path, { mode, oid });
	}
	return result;
}
const paths = (bytes: Buffer) => bytes.toString("utf8").split("\0").filter(Boolean).map(safePath);
async function symlinkAncestor(
	root: string,
	path: string,
): Promise<{ path: string; target: string } | undefined> {
	const parts = safePath(path).split("/");
	for (let depth = 1; depth < parts.length; depth++) {
		const ancestor = parts.slice(0, depth).join("/");
		const absolute = join(root, ancestor);
		const stat = await lstat(absolute);
		if (stat.isSymbolicLink()) return { path: ancestor, target: await readlink(absolute) };
		if (!stat.isDirectory()) throw Object.assign(new Error("Parent is not a directory"), { code: "ENOTDIR" });
	}
	return undefined;
}
async function workingTree(
	repo: Repo,
	head: string | null,
	config: Config,
	signal?: AbortSignal,
): Promise<Map<string, Entry>> {
	if ((await git(repo.root, ["ls-files", "--unmerged", "-z"], signal)).length)
		throw new Error("Resolve merge conflicts before reviewing");
	const flagged = (await git(repo.root, ["ls-files", "-v", "-z"], signal))
		.toString("utf8")
		.split("\0")
		.filter((entry) => entry && (/[a-z]/.test(entry[0]!) || entry[0] === "S"));
	if (flagged.length)
		throw new Error(
			"Index flags (assume-unchanged/skip-worktree) can hide source changes; capture is refused without modifying your index.",
		);
	const result = await tree(repo, head, signal);
	const dirty = head
		? paths(
				await git(
					repo.root,
					["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", head, "--"],
					signal,
				),
			)
		: paths(await git(repo.root, ["ls-files", "--cached", "-z"], signal));
	const untracked = paths(await git(repo.root, ["ls-files", "--others", "--exclude-standard", "-z"], signal));
	const format = (await git(repo.root, ["rev-parse", "--show-object-format"], signal)).toString().trim();
	let total = 0;
	for (const path of new Set([...dirty, ...untracked])) {
		signal?.throwIfAborted();
		const full = join(repo.root, path);
		try {
			const ancestor = await symlinkAncestor(repo.root, path);
			if (ancestor) {
				result.set(path, {
					mode: result.get(path)?.mode ?? "100644",
					oid: `blocked:${hash(JSON.stringify(ancestor))}`,
					unavailable: `symlink ancestor (not followed): ${ancestor.path}`,
				});
				continue;
			}
			if (!inside(repo.root, await realpath(dirname(full))))
				throw new Error("Source path escapes repository");
			const stat = await lstat(full);
			if (stat.isSymbolicLink()) {
				const data = Buffer.from(await readlink(full));
				result.set(path, {
					mode: "120000",
					oid: blobId(data, format === "sha256" ? 64 : 40),
					unavailable: "symlink (not followed)",
				});
			} else if (!stat.isFile() || stat.size > config.maxFileBytes) {
				result.set(path, {
					mode: result.get(path)?.mode ?? "100644",
					oid: `${stat.size}:${stat.mtimeMs}`,
					unavailable: stat.isDirectory()
						? "submodule/directory (not traversed)"
						: "oversized or non-regular file",
				});
			} else {
				const data = await readFile(full);
				total += data.length;
				if (total > config.maxDiffBytes * 4)
					throw new Error("Working-tree capture exceeds memory budget; narrow the changeset");
				result.set(path, {
					mode: stat.mode & 0o111 ? "100755" : "100644",
					oid: blobId(data, format === "sha256" ? 64 : 40),
					data,
				});
			}
		} catch (error) {
			if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) result.delete(path);
			else throw error;
		}
	}
	return result;
}
const fingerprint = (head: string | null, entries: Map<string, Entry>) =>
	hash(
		JSON.stringify([
			head,
			[...entries]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([path, entry]) => [path, entry.mode, entry.oid]),
		]),
	);
function text(data: Buffer): string {
	const decoded = data.toString("utf8");
	if (data.includes(0) || !Buffer.from(decoded).equals(data)) throw new Error("binary/non-UTF8 content");
	return decoded;
}
const quote = (path: string) => (/[\s"\\]/.test(path) ? JSON.stringify(path) : path);
export async function capture(
	repo: Repo,
	scope: Scope,
	config: Config,
	exclusions: Array<{ glob: string; reason: string }> = [],
	signal?: AbortSignal,
): Promise<Snapshot> {
	const head = await resolveCommit(repo.root, "HEAD", signal, true);
	const live = await workingTree(repo, head, config, signal);
	const committed = scope.kind !== "local" && scope.committedOnly;
	const target = committed ? await tree(repo, head, signal) : live;
	let baseline: string | null = head;
	if (scope.kind === "commits") {
		if (!head) throw new Error("No commits available");
		baseline = await resolveCommit(repo.root, `${head}~${scope.count}`, signal);
	} else if (scope.kind === "base") {
		if (!head) throw new Error("Branch review requires HEAD");
		const baseRef = await resolveCommit(repo.root, scope.ref, signal);
		baseline = (await git(repo.root, ["merge-base", "--end-of-options", head, baseRef!], signal))
			.toString()
			.trim();
		if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(baseline)) throw new Error("No available merge base");
	} else if (head && fingerprint(head, live) === fingerprint(head, await tree(repo, head, signal))) {
		// Only a truly clean index/worktree falls back; staged reverts are not clean.
		const status = await git(repo.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal);
		if (status.length === 0) baseline = await firstParent(repo.root, head, signal);
	}
	const before = await tree(repo, baseline, signal);
	const cache = new BlobCache({
		maxBytes: Math.max(config.maxFileBytes, config.maxDiffBytes),
		maxFileBytes: config.maxFileBytes,
		size: async (id) => Number((await git(repo.root, ["cat-file", "-s", id], signal)).toString()),
		load: (id, size) => git(repo.root, ["cat-file", "blob", id], signal, false, size),
	});
	async function readEntry(entry: Entry | undefined): Promise<Buffer> {
		if (!entry) throw new Error("File not present in snapshot");
		if (entry.unavailable || !["100644", "100755"].includes(entry.mode))
			throw new Error(entry.unavailable ?? "symlink/submodule content unavailable");
		if (entry.data) return entry.data;
		return cache.get(entry.oid);
	}
	const changes: Change[] = [];
	const omitted: Snapshot["omitted"] = [];
	let totalPatch = 0;
	const deleted = new Map<string, string>();
	for (const [path, entry] of before) if (!target.has(path)) deleted.set(`${entry.mode}:${entry.oid}`, path);
	const renamedOld = new Set<string>();
	const renames = new Map<string, string>();
	for (const [path, entry] of target)
		if (!before.has(path)) {
			const old = deleted.get(`${entry.mode}:${entry.oid}`);
			if (old && !renamedOld.has(old)) {
				renames.set(path, old);
				renamedOld.add(old);
			}
		}
	for (const file of [...new Set([...before.keys(), ...target.keys()])].sort()) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		signal?.throwIfAborted();
		if (renamedOld.has(file)) continue;
		const oldPath = renames.get(file) ?? file;
		const old = before.get(oldPath),
			next = target.get(file);
		if (oldPath === file && old?.oid === next?.oid && old?.mode === next?.mode) continue;
		const exclusion = exclusions.find((item) => matchesGlob(file, item.glob));
		if (exclusion) {
			omitted.push({ file, reason: `excluded: ${exclusion.reason}` });
			continue;
		}
		try {
			const oldText = old ? text(await readEntry(old)) : "";
			const newText = next ? text(await readEntry(next)) : "";
			if (oldText.split("\n").length + newText.split("\n").length > 20000)
				throw new Error("file exceeds diff line-complexity budget");
			const diff = structuredPatch(
				old ? `a/${oldPath}` : "/dev/null",
				next ? `b/${file}` : "/dev/null",
				oldText,
				newText,
				"",
				"",
				{ context: 20, timeout: 1000, maxEditLength: 10000 },
			);
			if (!diff) throw new Error("diff computation budget exhausted");
			const change: Change = {
				file,
				oldPath,
				patch: "",
				added: [],
				removed: [],
				oldLines: new Set(),
				newLines: new Set(),
				metadataOnly: diff.hunks.length === 0,
			};
			const lines = [`diff --git ${quote(`a/${oldPath}`)} ${quote(`b/${file}`)}`];
			if (!old) lines.push(`new file mode ${next!.mode}`);
			else if (!next) lines.push(`deleted file mode ${old.mode}`);
			else if (old.mode !== next.mode) lines.push(`old mode ${old.mode}`, `new mode ${next.mode}`);
			if (oldPath !== file)
				lines.push("similarity index 100%", `rename from ${quote(oldPath)}`, `rename to ${quote(file)}`);
			if (diff.hunks.length) lines.push(`--- ${quote(diff.oldFileName)}`, `+++ ${quote(diff.newFileName)}`);
			for (const hunk of diff.hunks) {
				lines.push(
					`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
					...hunk.lines,
				);
				let oldLine = hunk.oldStart,
					newLine = hunk.newStart;
				for (const line of hunk.lines) {
					if (line.startsWith("-")) {
						change.oldLines.add(oldLine++);
						change.removed.push(line.slice(1));
					} else if (line.startsWith("+")) {
						change.newLines.add(newLine++);
						change.added.push(line.slice(1));
					} else if (line.startsWith(" ")) {
						oldLine++;
						newLine++;
					}
				}
			}
			change.patch = `${lines.join("\n")}\n`;
			totalPatch += Buffer.byteLength(change.patch);
			if (totalPatch > config.maxDiffBytes) throw new Error("diff exceeds capture budget");
			changes.push(change);
		} catch (error) {
			omitted.push({ file, reason: error instanceof Error ? error.message : "unavailable" });
		}
	}
	// A second independent capture detects edits made while the view was assembled.
	const currentHead = await resolveCommit(repo.root, "HEAD", signal, true);
	if (
		currentHead !== head ||
		fingerprint(head, live) !== fingerprint(head, await workingTree(repo, head, config, signal))
	)
		throw new Error("Repository changed during capture; retry review");
	return {
		repo,
		head,
		baseline,
		fingerprint: fingerprint(head, target),
		changes,
		omitted,
		paths: (side = "new") => [...(side === "old" ? before : target).keys()].sort(),
		async read(path, side = "new") {
			safePath(path);
			const actual = side === "old" ? (renames.get(path) ?? path) : path;
			const data = await readEntry((side === "old" ? before : target).get(actual));
			text(data);
			return data;
		},
	};
}
export async function assertCurrent(snapshot: Snapshot, config: Config, signal?: AbortSignal): Promise<void> {
	const head = await resolveCommit(snapshot.repo.root, "HEAD", signal, true);
	const current = await workingTree(snapshot.repo, head, config, signal);
	if (fingerprint(head, current) !== snapshot.fingerprint)
		throw new Error("Source changed since review; rerun /pr before requesting fixes");
}
function defineSnapshotTool<T extends TSchema>(tool: AgentTool<T>): AgentTool {
	return tool as AgentTool;
}
export function snapshotTools(snapshot: Snapshot): AgentTool[] {
	const read = createReadTool(snapshot.repo.root, {
		operations: {
			readFile: async (absolute) => snapshot.read(relativeSnapshotPath(snapshot, absolute)),
			access: async (absolute) => {
				await snapshot.read(relativeSnapshotPath(snapshot, absolute));
			},
			detectImageMimeType: async () => null,
		},
	});
	return [
		read,
		defineSnapshotTool({
			name: "read_before",
			label: "Read baseline",
			description:
				"Read baseline source (old/deleted side), bounded to 200 lines. Paths are repository-relative.",
			parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })) }),
			execute: async (_id, args) => ({
				content: [
					{
						type: "text",
						text: (await snapshot.read(args.path, "old"))
							.toString()
							.split("\n")
							.slice((args.offset ?? 1) - 1, (args.offset ?? 1) + 199)
							.join("\n")
							.slice(0, 50000),
					},
				],
				details: {},
			}),
		}),
		defineSnapshotTool({
			name: "read_change",
			label: "Read captured diff",
			description:
				"Read captured change hunks and file mode/rename metadata, at most 200 diff lines per page. Offset counts diff lines, not source-file line numbers. Never reads live files.",
			parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })) }),
			execute: async (_id, args) => {
				const change = snapshot.changes.find((item) => item.file === args.path || item.oldPath === args.path);
				if (!change) throw new Error("No captured change for that path");
				const lines = change.patch.split("\n"),
					offset = args.offset ?? 1;
				const page = truncateHead(lines.slice(offset - 1, offset + 199).join("\n"), {
					maxLines: 200,
					maxBytes: 48000,
				});
				return {
					content: [
						{
							type: "text",
							text: `Captured diff: ${change.file}\n${page.content}\n[Diff lines ${offset}-${offset + page.outputLines - 1} of ${lines.length}; next offset ${offset + page.outputLines}${page.truncated ? "; page truncated" : ""}]`,
						},
					],
					details: {},
				};
			},
		}),
		defineSnapshotTool({
			name: "list_source",
			label: "List captured files",
			description: "List up to 200 captured repository paths matching a glob. Use offset to page.",
			parameters: Type.Object({
				glob: Type.Optional(Type.String()),
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
			}),
			execute: async (_id, args) => {
				const files = snapshot.paths().filter((path) => !args.glob || matchesGlob(path, args.glob));
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								total: files.length,
								paths: files.slice(args.offset ?? 0, (args.offset ?? 0) + 200),
							}),
						},
					],
					details: {},
				};
			},
		}),
		defineSnapshotTool({
			name: "search_source",
			label: "Search captured source",
			description:
				"Literal search in captured text; scans up to 200 files per call and returns at most 100 matches. Use offset to page files.",
			parameters: Type.Object({
				query: Type.String({ minLength: 1, maxLength: 256 }),
				glob: Type.Optional(Type.String()),
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
			}),
			execute: async (_id, args, signal) => {
				const all = snapshot.paths().filter((path) => !args.glob || matchesGlob(path, args.glob));
				const selected = all.slice(args.offset ?? 0, (args.offset ?? 0) + 200);
				const found: Array<{ file: string; line: number; text: string }> = [];
				let scanned = 0;
				for (const file of selected) {
					if (found.length >= 100) break;
					signal?.throwIfAborted();
					scanned++;
					try {
						const lines = (await snapshot.read(file)).toString().split("\n");
						for (let i = 0; i < lines.length && found.length < 100; i++)
							if (lines[i]!.includes(args.query))
								found.push({ file, line: i + 1, text: lines[i]!.slice(0, 300) });
					} catch {
						/* unavailable files cannot be searched */
					}
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								scanned,
								totalFiles: all.length,
								nextOffset: (args.offset ?? 0) + scanned,
								matches: found,
								matchLimitReached: found.length === 100,
							}),
						},
					],
					details: {},
				};
			},
		}),
	];
}
function relativeSnapshotPath(snapshot: Snapshot, absolute: string): string {
	if (!inside(snapshot.repo.root, absolute)) throw new Error("Read outside captured repository refused");
	return safePath(absolute.slice(snapshot.repo.root.length + 1));
}
