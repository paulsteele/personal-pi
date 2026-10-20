import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const EXPORT_SHARD_BYTES = 512 * 1024;
export const MAX_EXPORT_BYTES = 128 * 1024 * 1024;
export const EXPORT_VERSION = 1;
export const exportHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function exportShardName(artifact, shardIndex) {
	return `${artifact}-${shardIndex}.bin`;
}
async function writeArtifact(directory, artifact, chunks) {
	const shards = [];
	let pending = Buffer.alloc(0);
	let totalBytes = 0;
	const flush = async () => {
		await writeFile(join(directory, exportShardName(artifact, shards.length)), pending, { mode: 0o600 });
		shards.push({ bytes: pending.length, hash: exportHash(pending) });
		pending = Buffer.alloc(0);
	};
	for await (const chunk of chunks) {
		totalBytes += chunk.length;
		if (totalBytes > MAX_EXPORT_BYTES) {
			throw new Error(`DRY ${artifact} export exceeds ${MAX_EXPORT_BYTES} bytes`);
		}
		let offset = 0;
		while (offset < chunk.length) {
			const remainingShardBytes = EXPORT_SHARD_BYTES - pending.length;
			const end = Math.min(chunk.length, offset + remainingShardBytes);
			pending = Buffer.concat([pending, chunk.subarray(offset, end)]);
			offset = end;
			if (pending.length === EXPORT_SHARD_BYTES) {
				await flush();
			}
		}
	}
	if (pending.length) {
		await flush();
	}
	return { bytes: totalBytes, shards };
}
async function* indexChunks(options, sources) {
	for (const source of sources) {
		const bytes = await readFile(join(options.directory, "index", `${source.path}.json`));
		yield bytes;
		yield Buffer.from("\n");
	}
}
export async function prepareBaselineExport(options, manifest, report, paths) {
	const requestedPaths = paths === undefined ? undefined : new Set(paths);
	const sources = requestedPaths
		? manifest.files.filter((file) => requestedPaths.has(file.path))
		: manifest.files;
	const root = join(options.directory, "exports");
	await rm(root, { recursive: true, force: true });
	const directory = join(root, manifest.revision);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const artifacts = {};
	artifacts.manifest = await writeArtifact(directory, "manifest", [Buffer.from(JSON.stringify(manifest))]);
	artifacts.report = await writeArtifact(directory, "report", [Buffer.from(JSON.stringify(report))]);
	artifacts.index = await writeArtifact(directory, "index", indexChunks(options, sources));
	return { version: EXPORT_VERSION, revision: manifest.revision, indexFiles: sources.length, artifacts };
}
