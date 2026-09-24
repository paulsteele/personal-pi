import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { QualityConfig } from "./config.js";
import type { ReviewFile } from "./proposal.js";

export class CoverageError extends Error {
	constructor(
		readonly path: string,
		readonly kind: "external" | "sensitive" | "size" | "binary" | "unsupported",
		message: string,
	) {
		super(message);
	}
}
export function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return resolve(canonicalPath(parent), basename(path));
	}
}
export function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return (
		!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
	);
}
export function sensitivePath(path: string): boolean {
	return /(?:^|[/\\])(?:\.env(?:\..+)?|auth\.json|credentials(?:\.json)?|id_(?:rsa|ed25519)|[^/\\]+\.(?:pem|key|p12))$/i.test(
		path,
	);
}
export function containsSecrets(text: string): boolean {
	return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}\b|\bBearer\s+[A-Za-z0-9._~-]{20,}/.test(
		text,
	);
}
export function readSnapshot(
	path: string,
	config: QualityConfig,
	cwd: string,
	authorized = false,
): string | null {
	if (!authorized && !inside(canonicalPath(cwd), path))
		throw new CoverageError(path, "external", "Path is outside the workspace");
	if (!authorized && sensitivePath(path))
		throw new CoverageError(
			path,
			"sensitive",
			"Potentially sensitive file; authorize review with the configured provider first",
		);
	let fd: number;
	try {
		if (!lstatSync(path).isFile()) throw new CoverageError(path, "unsupported", "Not a regular file");
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new CoverageError(path, "unsupported", "Not a regular file");
		if (stat.size > config.maxFileBytes) throw new CoverageError(path, "size", "File exceeds maxFileBytes");
		const buffer = Buffer.alloc(Math.min(config.maxFileBytes + 1, stat.size + 1));
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, length);
			if (!count) break;
			length += count;
		}
		if (length > config.maxFileBytes || length > stat.size)
			throw new CoverageError(path, "size", "File grew during snapshot capture");
		const bytes = buffer.subarray(0, length);
		const text = bytes.toString("utf8");
		if (bytes.includes(0) || !Buffer.from(text).equals(bytes))
			throw new CoverageError(path, "binary", "Binary or non-UTF-8 content is outside text review");
		if (!authorized && containsSecrets(text))
			throw new CoverageError(
				path,
				"sensitive",
				"Possible secret detected; authorize the provider before review",
			);
		return text;
	} finally {
		closeSync(fd);
	}
}
export interface SnapshotFile {
	path: string;
	before: string | null;
	after: string | null;
}
export interface ReviewChunk {
	input: string;
	files: ReviewFile[];
}

interface ReviewHunk {
	diff: string;
	postEditExcerpt: string;
	visibleRange: [number, number];
	changedRanges: Array<[number, number]>;
}

function captureReviewHunk(diff: string, afterLines: string[]): ReviewHunk {
	const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(diff);
	if (!header) throw new Error("Invalid generated hunk");
	const start = Number(header[1]);
	const count = Number(header[2] ?? 1);
	const end = Math.max(start, start + count - 1);
	let line = start;
	const changedRanges: Array<[number, number]> = [];
	for (const value of diff.split("\n").slice(1)) {
		if (value.startsWith("+")) {
			changedRanges.push([Math.max(1, line), Math.max(1, line)]);
			line++;
		} else if (value.startsWith("-")) changedRanges.push([Math.max(1, line), Math.max(1, line)]);
		else if (value.startsWith(" ")) line++;
	}
	const postEditExcerpt = afterLines
		.slice(Math.max(0, start - 1), end)
		.map((text, i) => `${Math.max(1, start) + i}: ${text}`)
		.join("\n");
	return { diff, postEditExcerpt, visibleRange: [Math.max(1, start), Math.max(1, end)], changedRanges };
}

function groupFileHunks(file: SnapshotFile, hunks: ReviewHunk[], totalChangedHunks: number): ReviewChunk {
	const input = JSON.stringify({
		file: file.path,
		fileKind: /\.(md|mdx|rst|txt)$/i.test(file.path)
			? "document"
			: /\.(json|ya?ml|toml|ini)$/i.test(file.path)
				? "configuration"
				: "code",
		diff: hunks.map((hunk) => hunk.diff).join("\n"),
		postEditExcerpt: hunks.map((hunk) => hunk.postEditExcerpt).join("\n\n"),
		context: { kind: "changed-hunk-excerpts", includedChangedHunks: hunks.length, totalChangedHunks },
		untrusted: true,
	});
	return {
		input,
		files: [
			{
				path: file.path,
				before: file.before,
				after: file.after ?? "",
				visibleRanges: hunks.map((hunk) => hunk.visibleRange),
				changedRanges: hunks.flatMap((hunk) => hunk.changedRanges),
			},
		],
	};
}

export function buildReviewChunks(files: SnapshotFile[], config: QualityConfig, cwd: string): ReviewChunk[] {
	if (
		files.reduce((n, f) => n + Buffer.byteLength(f.before ?? "") + Buffer.byteLength(f.after ?? ""), 0) >
		config.maxBatchBytes
	)
		throw new CoverageError(cwd, "size", "Batch exceeds maxBatchBytes");
	const chunks: ReviewChunk[] = [];
	const allowance = config.maxInputChars - 14_000;
	for (const file of files) {
		if (file.before === file.after) continue;
		const after = file.after ?? "";
		const afterLines = after.split("\n");
		const patch = generateUnifiedPatch(relative(cwd, file.path), file.before ?? "", after, 20);
		const hunks = patch
			.split(/(?=^@@ )/m)
			.filter((part) => part.startsWith("@@ "))
			.map((diff) => captureReviewHunk(diff, afterLines));
		if (!hunks.length)
			throw new CoverageError(file.path, "unsupported", "Changed content has no exact textual diff");
		let pendingHunks: ReviewHunk[] = [];
		let pendingChunk: ReviewChunk | undefined;
		for (const hunk of hunks) {
			const candidate = groupFileHunks(file, [...pendingHunks, hunk], hunks.length);
			if (candidate.input.length <= allowance) {
				pendingHunks.push(hunk);
				pendingChunk = candidate;
				continue;
			}
			if (pendingChunk) chunks.push(pendingChunk);
			pendingHunks = [hunk];
			pendingChunk = groupFileHunks(file, pendingHunks, hunks.length);
			if (pendingChunk.input.length > allowance)
				throw new CoverageError(file.path, "size", "An indivisible changed hunk exceeds maxInputChars");
		}
		if (pendingChunk) chunks.push(pendingChunk);
	}
	return chunks;
}
