import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, join, matchesGlob } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";
import { firstParent, git, gitBlobToFile, resolveCommit } from "./git.js";
import { ExactDiffWorker } from "./exact-diff.js";
import { SnapshotStore, textLineCount, textLinePage, textPage } from "./snapshot-store.js";
import { safePath } from "./profile.js";
import { hash } from "./prompts.js";
import { inside } from "./storage.js";
import type { Config, Repo, Scope } from "./types.js";

type Entry = { mode: string; oid: string; data?: Buffer; backing?: string | undefined; unavailable?: string };
export interface Change {
	file: string;
	oldPath: string;
	patch: string;
	added: string[];
	removed: string[];
	oldLines: Set<number>;
	newLines: Set<number>;
	metadataOnly: boolean;
	patchPath?: string;
	changedRanges?: { old: Array<[number, number]>; new: Array<[number, number]> };
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
	page?(
		path: string,
		side: "old" | "new",
		offset: number,
		limit?: number,
		signal?: AbortSignal,
	): Promise<{ text: string; nextOffset: number | null; total: number }>;
	readLines?(
		path: string,
		side: "old" | "new",
		offset: number,
		limit: number,
		maxChars?: number,
		signal?: AbortSignal,
	): Promise<{ start: number; text: string; total: number; lineCount: number; nextOffset: number | null }>;
	lineCount?(path: string, side: "old" | "new", signal?: AbortSignal): Promise<number>;
	writePatch?(destination: string, signal?: AbortSignal): Promise<void>;
	dispose?(): Promise<void>;
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
	_config: Config,
	signal?: AbortSignal,
	store?: SnapshotStore,
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
			} else if (!stat.isFile()) {
				result.set(path, {
					mode: result.get(path)?.mode ?? "100644",
					oid: `${stat.size}:${stat.mtimeMs}`,
					unavailable: stat.isDirectory() ? "submodule/directory (not traversed)" : "non-regular file",
				});
			} else {
				let oid: string, backing: string | undefined;
				if (store) {
					const copied = await store.copy(full, stat.size, format === "sha256" ? 64 : 40, signal);
					oid = copied.oid;
					backing = copied.path;
				} else {
					const digest = createHash(format === "sha256" ? "sha256" : "sha1").update(`blob ${stat.size}\0`);
					let bytes = 0;
					for await (const chunk of createReadStream(full, { signal })) {
						digest.update(chunk);
						bytes += chunk.length;
					}
					if (bytes !== stat.size) throw new Error("Source changed during capture");
					oid = digest.digest("hex");
				}
				result.set(path, { mode: stat.mode & 0o111 ? "100755" : "100644", oid, backing });
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
function patchData(patch: string) {
	const added: string[] = [],
		removed: string[] = [],
		oldLines = new Set<number>(),
		newLines = new Set<number>();
	let oldLine = 0,
		newLine = 0,
		inHunk = false;
	for (const line of patch.split("\n")) {
		const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		if (line.startsWith("-")) {
			oldLines.add(oldLine++);
			removed.push(line.slice(1));
		} else if (line.startsWith("+")) {
			newLines.add(newLine++);
			added.push(line.slice(1));
		} else if (line.startsWith(" ")) {
			oldLine++;
			newLine++;
		}
	}
	return { added, removed, oldLines, newLines };
}
function expandRanges(ranges: Array<[number, number]>): Set<number> {
	const lines = new Set<number>();
	for (const [start, end] of ranges) for (let line = start; line <= end; line++) lines.add(line);
	return lines;
}
export async function capture(
	repo: Repo,
	scope: Scope,
	config: Config,
	exclusions: Array<{ glob: string; reason: string }> = [],
	signal?: AbortSignal,
): Promise<Snapshot> {
	const store = await SnapshotStore.create(repo);
	const diffWorker = new ExactDiffWorker();
	try {
		const head = await resolveCommit(repo.root, "HEAD", signal, true);
		const live = await workingTree(repo, head, config, signal, store);
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
			const status = await git(
				repo.root,
				["status", "--porcelain=v1", "-z", "--untracked-files=all"],
				signal,
			);
			if (status.length === 0) baseline = await firstParent(repo.root, head, signal);
		}
		const before = await tree(repo, baseline, signal);
		const blobs = new Map<string, Promise<string>>();
		const empty = await store.put("");
		async function entryPath(entry: Entry | undefined): Promise<string> {
			if (!entry) throw new Error("File not present in snapshot");
			if (entry.unavailable || !["100644", "100755"].includes(entry.mode))
				throw new Error(entry.unavailable ?? "symlink/submodule content unavailable");
			if (entry.backing) return entry.backing;
			let pending = blobs.get(entry.oid);
			if (!pending) {
				const path = store.allocate();
				pending = gitBlobToFile(repo.root, entry.oid, path, signal).then(() => path);
				blobs.set(entry.oid, pending);
				void pending.catch(() => blobs.delete(entry.oid));
			}
			return pending;
		}
		const changes: Change[] = [];
		const omitted: Snapshot["omitted"] = [];
		const deleted = new Map<string, string>();
		for (const [path, entry] of before)
			if (!target.has(path)) deleted.set(`${entry.mode}:${entry.oid}`, path);
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
				const patchPath = store.allocate();
				const diff = await diffWorker.diff(
					{
						oldFile: old ? await entryPath(old) : empty,
						newFile: next ? await entryPath(next) : empty,
						oldPath,
						file,
						oldMode: old?.mode,
						newMode: next?.mode,
						output: patchPath,
					},
					signal,
				);
				const patch = () => readFileSync(patchPath, "utf8");
				let oldLines: Set<number> | undefined, newLines: Set<number> | undefined;
				changes.push({
					file,
					oldPath,
					patchPath,
					metadataOnly: diff.metadataOnly,
					changedRanges: { old: diff.oldRanges, new: diff.newRanges },
					get patch() {
						return patch();
					},
					get added() {
						return patchData(patch()).added;
					},
					get removed() {
						return patchData(patch()).removed;
					},
					get oldLines() {
						return (oldLines ??= expandRanges(diff.oldRanges));
					},
					get newLines() {
						return (newLines ??= expandRanges(diff.newRanges));
					},
				});
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
			dispose: () => store.dispose(),
			async writePatch(destination, writeSignal) {
				async function* chunks() {
					for (const change of changes) {
						writeSignal?.throwIfAborted();
						if (!change.patchPath || !inside(store.directory, change.patchPath))
							throw new Error("Patch is not owned by this snapshot");
						yield* createReadStream(change.patchPath, { signal: writeSignal });
					}
				}
				await pipeline(
					Readable.from(chunks(), { objectMode: false }),
					createWriteStream(destination, { flags: "wx", mode: 0o600 }),
					{ signal: writeSignal },
				);
			},
			async readLines(path, side, offset, limit, maxChars, pageSignal) {
				safePath(path);
				const actual = side === "old" ? (renames.get(path) ?? path) : path;
				return textLinePage(
					await entryPath((side === "old" ? before : target).get(actual)),
					offset,
					limit,
					maxChars,
					pageSignal,
				);
			},
			async lineCount(path, side, pageSignal) {
				safePath(path);
				const actual = side === "old" ? (renames.get(path) ?? path) : path;
				return textLineCount(await entryPath((side === "old" ? before : target).get(actual)), pageSignal);
			},
			paths: (side = "new") => [...(side === "old" ? before : target).keys()].sort(),
			async page(path, side, offset, limit, pageSignal) {
				safePath(path);
				const actual = side === "old" ? (renames.get(path) ?? path) : path;
				return textPage(
					await entryPath((side === "old" ? before : target).get(actual)),
					offset,
					limit,
					pageSignal,
				);
			},
			async read(path, side = "new") {
				safePath(path);
				const actual = side === "old" ? (renames.get(path) ?? path) : path;
				const data = await readFile(await entryPath((side === "old" ? before : target).get(actual)));
				text(data);
				return data;
			},
		};
	} catch (error) {
		await diffWorker.dispose();
		await store.dispose();
		throw error;
	} finally {
		await diffWorker.dispose();
	}
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
export function snapshotTools(
	snapshot: Snapshot,
	delivered?: (id: string, start: number, end: number, total: number) => void,
): AgentTool[] {
	const read = defineSnapshotTool({
		name: "read",
		label: "Read captured source",
		description:
			"Read captured source. offset/limit count lines (offset starts at 1); cursor resumes a character page. Follow nextCursor for long files. Reads automatically count as supplied context; no acknowledgment is required.",
		parameters: Type.Object({
			path: Type.String(),
			offset: Type.Optional(Type.Integer({ minimum: 1 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
			cursor: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		execute: async (_id, args, signal) => {
			const requested = args.path.replace(/^@/, "");
			const path = requested.startsWith("/")
				? relativeSnapshotPath(snapshot, requested)
				: safePath(requested);
			let page: { text: string; total: number; nextOffset: number | null }, start: number;
			if (args.cursor !== undefined) {
				start = args.cursor;
				page = snapshot.page
					? await snapshot.page(path, "new", start, 16000, signal)
					: stringPage((await snapshot.read(path)).toString(), start);
			} else {
				const lines = await snapshotLines(
					snapshot,
					path,
					"new",
					args.offset ?? 1,
					args.limit ?? 2000,
					16000,
					signal,
				);
				start = lines.start;
				page = lines;
			}
			signal?.throwIfAborted();
			delivered?.(`doc:${path}`, start, start + page.text.length, page.total);
			return {
				content: [
					{
						type: "text",
						text: `${page.text}\n[${JSON.stringify({ path, nextCursor: page.nextOffset, total: page.total })}]`,
					},
				],
				details: {},
			};
		},
	});
	return [
		read,
		defineSnapshotTool({
			name: "list_changes",
			label: "List captured changes",
			description:
				"Page the complete captured changed-file manifest; excluded/unavailable files are listed separately by the harness. Offset is a file index.",
			parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
			execute: async (_id, args) => {
				const offset = args.offset ?? 0;
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								total: snapshot.changes.length,
								files: snapshot.changes
									.slice(offset, offset + 100)
									.map((c) => ({ file: c.file, oldPath: c.oldPath, metadataOnly: c.metadataOnly })),
								nextOffset: offset + 100 < snapshot.changes.length ? offset + 100 : null,
							}),
						},
					],
					details: {},
				};
			},
		}),
		defineSnapshotTool({
			name: "read_source_page",
			label: "Read captured source page",
			description:
				"Read exact captured text with a character cursor (not a line offset). Continue nextOffset until null, including long lines. Use this for required documents so coverage is recorded. side defaults to new.",
			parameters: Type.Object({
				path: Type.String(),
				side: Type.Optional(Type.String({ enum: ["old", "new"] })),
				cursor: Type.Optional(Type.Integer({ minimum: 0 })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })),
			}),
			execute: async (_id, args, signal) => {
				const offset = args.cursor ?? 0,
					side = args.side === "old" ? "old" : "new";
				const page = snapshot.page
					? await snapshot.page(args.path, side, offset, args.limit, signal)
					: stringPage((await snapshot.read(args.path, side)).toString(), offset, args.limit);
				if (side === "new") delivered?.(`doc:${args.path}`, offset, offset + page.text.length, page.total);
				return { content: [{ type: "text", text: JSON.stringify(page) }], details: {} };
			},
		}),
		defineSnapshotTool({
			name: "read_before",
			label: "Read baseline",
			description:
				"Read baseline source (old/deleted side), bounded to 200 lines. Paths are repository-relative.",
			parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })) }),
			execute: async (_id, args, signal) => {
				const page = await snapshotLines(snapshot, args.path, "old", args.offset ?? 1, 200, 16000, signal);
				return {
					content: [
						{
							type: "text",
							text: `${page.text}\n[${JSON.stringify({ nextCursor: page.nextOffset, total: page.total })}]`,
						},
					],
					details: {},
				};
			},
		}),
		defineSnapshotTool({
			name: "read_change",
			label: "Read captured diff",
			description:
				"Read captured diff with a character cursor (default 0); continue nextOffset until null to record full coverage. Includes mode/rename metadata. Legacy offset counts diff lines. Never reads live files.",
			parameters: Type.Object({
				path: Type.String(),
				cursor: Type.Optional(Type.Integer({ minimum: 0 })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })),
				offset: Type.Optional(Type.Integer({ minimum: 1 })),
			}),
			execute: async (_id, args, signal) => {
				signal?.throwIfAborted();
				const change = snapshot.changes.find((item) => item.file === args.path || item.oldPath === args.path);
				if (!change) throw new Error("No captured change for that path");
				if (args.offset === undefined) {
					const offset = args.cursor ?? 0;
					const page = change.patchPath
						? await textPage(change.patchPath, offset, args.limit, signal)
						: stringPage(change.patch, offset, args.limit);
					signal?.throwIfAborted();
					delivered?.(`diff:${change.file}`, offset, offset + page.text.length, page.total);
					return {
						content: [
							{
								type: "text",
								text: `${page.text}\n[${JSON.stringify({ file: change.file, nextOffset: page.nextOffset, total: page.total })}]`,
							},
						],
						details: {},
					};
				}
				const page = change.patchPath
					? await textLinePage(change.patchPath, args.offset, 200, 16000, signal)
					: linePage(change.patch, args.offset, 200);
				signal?.throwIfAborted();
				delivered?.(`diff:${change.file}`, page.start, page.start + page.text.length, page.total);
				return {
					content: [
						{
							type: "text",
							text: `${page.text}\n[${JSON.stringify({ file: change.file, nextCursor: page.nextOffset, total: page.total })}]`,
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
export async function snapshotLines(
	snapshot: Snapshot,
	path: string,
	side: "old" | "new",
	offset: number,
	limit: number,
	maxChars = 16000,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	if (snapshot.readLines) return snapshot.readLines(path, side, offset, limit, maxChars, signal);
	if (!snapshot.page) return linePage((await snapshot.read(path, side)).toString(), offset, limit);
	// Compatibility for paged adapters without a line index; never fall back to a full-buffer read.
	let start = 0,
		line = 1;
	while (line < offset) {
		const page = await snapshot.page(path, side, start, 16000, signal);
		let found = false;
		for (let at = page.text.indexOf("\n"); at >= 0; at = page.text.indexOf("\n", at + 1))
			if (++line === offset) {
				start += at + 1;
				found = true;
				break;
			}
		if (found) break;
		if (page.nextOffset === null) {
			start = page.total;
			break;
		}
		start = page.nextOffset;
	}
	const page = await snapshot.page(path, side, start, maxChars, signal);
	const text = linePage(page.text, 1, limit).text;
	signal?.throwIfAborted();
	return {
		start,
		text,
		total: page.total,
		nextOffset: start + text.length < page.total ? start + text.length : null,
	};
}
function linePage(source: string, offset: number, limit: number) {
	let start = 0;
	for (let line = 1; line < offset; line++) {
		const next = source.indexOf("\n", start);
		start = next < 0 ? source.length : next + 1;
		if (start === source.length) break;
	}
	let end = start;
	for (let line = 0; line < limit && end < source.length; line++) {
		const next = source.indexOf("\n", end);
		end = next < 0 ? source.length : next + 1;
	}
	const text = source.slice(start, Math.min(end, start + 16000));
	return {
		start,
		text,
		total: source.length,
		nextOffset: start + text.length < source.length ? start + text.length : null,
	};
}
export async function* contextResources(
	snapshot: Snapshot,
	ids: string[],
	maxChars: number,
	signal: AbortSignal,
) {
	for (const id of ids) {
		signal.throwIfAborted();
		const path = id.slice(id.indexOf(":") + 1);
		let page: { text: string; total: number };
		if (id.startsWith("diff:")) {
			const change = snapshot.changes.find((change) => change.file === path)!;
			page = change.patchPath
				? await textPage(change.patchPath, 0, maxChars, signal)
				: stringPage(change.patch, 0, maxChars);
		} else if (id.startsWith("doc:"))
			page = snapshot.page
				? await snapshot.page(path, "new", 0, maxChars, signal)
				: stringPage((await snapshot.read(path)).toString(), 0, maxChars);
		else throw new Error(`Not a snapshot resource: ${id}`);
		yield { id, text: page.text, total: page.total };
	}
}
function stringPage(value: string, offset: number, limit = 16000) {
	const text = value.slice(offset, offset + limit);
	return {
		text,
		total: value.length,
		nextOffset: offset + text.length < value.length ? offset + text.length : null,
	};
}
function relativeSnapshotPath(snapshot: Snapshot, absolute: string): string {
	if (!inside(snapshot.repo.root, absolute)) throw new Error("Read outside captured repository refused");
	return safePath(absolute.slice(snapshot.repo.root.length + 1));
}
