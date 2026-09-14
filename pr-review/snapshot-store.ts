import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ensurePrivateDirectory, initializeStorage, storageRoot } from "./storage.js";
import type { Repo } from "./types.js";
import { awaitWithSignal } from "./work-ui.js";

/** Run-owned private backing, never a cache of subsequently re-read live working files. */
export class SnapshotStore {
	private disposed = false;
	private constructor(readonly directory: string) {}
	static async create(repo: Repo): Promise<SnapshotStore> {
		const root = await storageRoot(getAgentDir(), repo);
		await initializeStorage(root);
		const parent = join(root, "snapshots");
		await ensurePrivateDirectory(parent);
		for (const name of await readdir(parent)) {
			if (!/^capture-[a-f0-9-]{36}$/.test(name)) continue;
			const directory = join(parent, name);
			try {
				if ((await lstat(directory)).isSymbolicLink()) continue;
				const owner = JSON.parse(await readFile(join(directory, "owner.json"), "utf8"));
				if (owner.kind !== "pr-snapshot" || !Number.isSafeInteger(owner.pid) || owner.pid < 1) continue;
				try {
					process.kill(owner.pid, 0);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ESRCH")
						await rm(directory, { recursive: true, force: true });
				}
			} catch {
				/* Unknown or active directories are not ours to delete. */
			}
		}
		const directory = join(parent, `capture-${randomUUID()}`);
		await mkdir(directory, { mode: 0o700 });
		await writeFile(
			join(directory, "owner.json"),
			JSON.stringify({ kind: "pr-snapshot", pid: process.pid }),
			{ mode: 0o600 },
		);
		return new SnapshotStore(directory);
	}
	allocate(): string {
		if (this.disposed) throw new Error("Snapshot disposed");
		return join(this.directory, randomUUID());
	}
	async put(data: Buffer | string): Promise<string> {
		const path = this.allocate();
		await writeFile(path, data, { mode: 0o600, flag: "wx" });
		return path;
	}
	async copy(
		path: string,
		size: number,
		oidLength: number,
		signal?: AbortSignal,
	): Promise<{ path: string; oid: string }> {
		const target = this.allocate();
		const hash = createHash(oidLength === 64 ? "sha256" : "sha1").update(`blob ${size}\0`);
		let bytes = 0;
		const input = createReadStream(path);
		input.on("data", (chunk) => {
			hash.update(chunk);
			bytes += chunk.length;
		});
		await pipeline(input, createWriteStream(target, { mode: 0o600, flags: "wx" }), { signal });
		if (bytes !== size) throw new Error("Source changed during capture");
		return { path: target, oid: hash.digest("hex") };
	}
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const path of textIndexes.keys())
			if (path.startsWith(`${this.directory}/`)) textIndexes.delete(path);
		await rm(this.directory, { recursive: true, force: true });
	}
}

interface TextIndex {
	total: number;
	lines: number;
	blocks: Array<{ chars: number; bytes: number; line: number; lineStart: number }>;
}
const textIndexes = new Map<string, Promise<TextIndex>>();
async function indexText(path: string, signal?: AbortSignal): Promise<TextIndex> {
	const blocks = [{ chars: 0, bytes: 0, line: 1, lineStart: 0 }];
	let chars = 0,
		bytes = 0,
		line = 1,
		lineStart = 0;
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	for await (const chunk of createReadStream(path, { signal })) {
		if (chunk.includes(0)) throw new Error("binary/non-UTF8 content");
		const value = decoder.decode(chunk, { stream: true });
		for (let at = value.indexOf("\n"); at >= 0; at = value.indexOf("\n", at + 1)) {
			line++;
			lineStart = chars + at + 1;
		}
		chars += value.length;
		bytes += Buffer.byteLength(value);
		blocks.push({ chars, bytes, line, lineStart }); // Complete UTF-8 boundary plus sparse line checkpoint.
	}
	decoder.decode();
	return { total: chars, lines: line, blocks };
}
async function textIndex(path: string, signal?: AbortSignal): Promise<TextIndex> {
	signal?.throwIfAborted();
	let pending = textIndexes.get(path);
	if (!pending) {
		pending = indexText(path, signal);
		textIndexes.set(path, pending);
		void pending.catch(() => {
			if (textIndexes.get(path) === pending) textIndexes.delete(path);
		});
	}
	return signal ? awaitWithSignal(pending, signal) : pending;
}
/** Index once, then seek near a character cursor. No quadratic rescanning of large diffs. */
export async function textPage(
	path: string,
	offset: number,
	limit = 16000,
	signal?: AbortSignal,
): Promise<{ text: string; nextOffset: number | null; total: number }> {
	const index = await textIndex(path, signal);
	signal?.throwIfAborted();
	if (offset > index.total) throw new Error("Cursor outside captured text");
	let low = 0,
		high = index.blocks.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (index.blocks[middle]!.chars <= offset) low = middle;
		else high = middle - 1;
	}
	const block = index.blocks[low]!;
	let at = block.chars,
		text = "";
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	for await (const chunk of createReadStream(path, { start: block.bytes, signal })) {
		const value = decoder.decode(chunk, { stream: true });
		const from = Math.max(0, offset - at),
			to = Math.min(value.length, offset + limit - at);
		if (to > from) text += value.slice(from, to);
		at += value.length;
		if (at >= offset + limit) break;
	}
	signal?.throwIfAborted();
	return {
		text,
		nextOffset: offset + text.length < index.total ? offset + text.length : null,
		total: index.total,
	};
}
export async function textLineCount(path: string, signal?: AbortSignal): Promise<number> {
	return (await textIndex(path, signal)).lines;
}
/** Seek via sparse line checkpoints, then return only the requested lines/character window. */
export async function textLinePage(
	path: string,
	offset: number,
	limit: number,
	maxChars = 16000,
	signal?: AbortSignal,
) {
	if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1)
		throw new Error("Invalid line range");
	const index = await textIndex(path, signal);
	let start = index.total;
	if (offset <= index.lines) {
		let low = 0,
			high = index.blocks.length - 1;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (index.blocks[middle]!.line <= offset) low = middle;
			else high = middle - 1;
		}
		const block = index.blocks[low]!;
		if (block.line === offset) start = block.lineStart;
		else {
			let line = block.line,
				chars = block.chars;
			const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
			outer: for await (const chunk of createReadStream(path, { start: block.bytes, signal })) {
				const value = decoder.decode(chunk, { stream: true });
				for (let at = value.indexOf("\n"); at >= 0; at = value.indexOf("\n", at + 1))
					if (++line === offset) {
						start = chars + at + 1;
						break outer;
					}
				chars += value.length;
			}
		}
	}
	const page = await textPage(path, start, maxChars, signal);
	let end = 0;
	for (let line = 0; line < limit && end < page.text.length; line++) {
		const next = page.text.indexOf("\n", end);
		end = next < 0 ? page.text.length : next + 1;
	}
	const text = page.text.slice(0, end);
	signal?.throwIfAborted();
	return {
		start,
		text,
		total: index.total,
		lineCount: index.lines,
		nextOffset: start + text.length < index.total ? start + text.length : null,
	};
}
