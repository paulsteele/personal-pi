import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
	EXPORT_SHARD_BYTES,
	EXPORT_VERSION,
	MAX_EXPORT_BYTES,
	exportHash,
	exportShardName,
	type DryBaselineExport,
	type DryExportArtifact,
} from "./dry-export.mjs";
import { assertIndexedFile, isManifest, isReport } from "./dry-worker-schema.js";
import type { DryBaselinePhase, DryIndexedFile, DryManifest, DryReport } from "./dry-types.js";

const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const artifactSchema = Type.Object({
	bytes: Type.Integer({ minimum: 0, maximum: MAX_EXPORT_BYTES }),
	shards: Type.Array(
		Type.Object({
			bytes: Type.Integer({ minimum: 1, maximum: EXPORT_SHARD_BYTES }),
			hash,
		}),
		{ maxItems: Math.ceil(MAX_EXPORT_BYTES / EXPORT_SHARD_BYTES) },
	),
});
const exportSchema = Type.Object({
	version: Type.Literal(EXPORT_VERSION),
	revision: hash,
	indexFiles: Type.Integer({ minimum: 0, maximum: 100000 }),
	artifacts: Type.Object({ manifest: artifactSchema, report: artifactSchema, index: artifactSchema }),
});
export interface DryExportReadPorts {
	read(path: string, maxBytes: number, signal: AbortSignal): Promise<Buffer>;
	phase(name: DryBaselinePhase): void;
}
export interface DryExportResult {
	manifest: DryManifest;
	report: DryReport;
	files: DryIndexedFile[];
	indexBytes: number;
	indexShards: number;
}
export function assertBaselineExport(value: unknown): asserts value is DryBaselineExport {
	if (!Check(exportSchema, value)) {
		throw new Error("Invalid DRY baseline export descriptor");
	}
	const descriptor = value as DryBaselineExport;
	for (const artifact of Object.values(descriptor.artifacts)) {
		if (artifact.shards.reduce((bytes, shard) => bytes + shard.bytes, 0) !== artifact.bytes) {
			throw new Error("DRY export shard sizes do not match artifact size");
		}
	}
}
async function* artifactChunks(
	directory: string,
	name: string,
	artifact: DryExportArtifact,
	ports: DryExportReadPorts,
	signal: AbortSignal,
) {
	for (const [shardIndex, shard] of artifact.shards.entries()) {
		signal.throwIfAborted();
		const bytes = await ports.read(join(directory, exportShardName(name, shardIndex)), shard.bytes, signal);
		if (bytes.length !== shard.bytes || exportHash(bytes) !== shard.hash) {
			throw new Error(`DRY ${name} shard ${shardIndex} failed size/hash validation`);
		}
		yield bytes;
	}
}
async function readJsonArtifact(
	directory: string,
	name: "manifest" | "report",
	artifact: DryExportArtifact,
	ports: DryExportReadPorts,
	signal: AbortSignal,
): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const bytes of artifactChunks(directory, name, artifact, ports, signal)) {
		chunks.push(bytes);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function readBaselineExport(
	root: string,
	value: unknown,
	ports: DryExportReadPorts,
	signal: AbortSignal,
): Promise<DryExportResult> {
	assertBaselineExport(value);
	const directory = join(root, "exports", value.revision);
	ports.phase("manifest transfer/validation");
	const manifest = await readJsonArtifact(directory, "manifest", value.artifacts.manifest, ports, signal);
	if (!isManifest(manifest) || manifest.revision !== value.revision) {
		throw new Error("DRY export manifest does not match descriptor revision");
	}
	ports.phase("report transfer/validation");
	const report = await readJsonArtifact(directory, "report", value.artifacts.report, ports, signal);
	if (!isReport(report) || report.manifestRevision !== manifest.revision) {
		throw new Error("DRY report does not match the baseline manifest");
	}
	ports.phase("index transfer/validation");
	const files: DryIndexedFile[] = [];
	const metadataByPath = new Map(manifest.files.map((file) => [file.path, file]));
	const exportedPaths = new Set<string>();
	let pending = Buffer.alloc(0);
	for await (const bytes of artifactChunks(directory, "index", value.artifacts.index, ports, signal)) {
		pending = Buffer.concat([pending, bytes]);
		let newline = pending.indexOf(10);
		while (newline >= 0) {
			const file: unknown = JSON.parse(pending.subarray(0, newline).toString("utf8"));
			assertIndexedFile(file);
			const metadata = metadataByPath.get(file.path);
			const matchesManifest =
				metadata &&
				Object.entries(metadata).every(([key, entry]) => file[key as keyof DryIndexedFile] === entry);
			if (!matchesManifest || exportedPaths.has(file.path)) {
				throw new Error(`DRY lexical file ${file.path} does not match a unique manifest entry`);
			}
			exportedPaths.add(file.path);
			files.push(file);
			pending = pending.subarray(newline + 1);
			newline = pending.indexOf(10);
		}
	}
	if (pending.length || files.length !== value.indexFiles) {
		throw new Error("DRY lexical export is incomplete");
	}
	signal.throwIfAborted();
	return {
		manifest,
		report,
		files,
		indexBytes: value.artifacts.index.bytes,
		indexShards: value.artifacts.index.shards.length,
	};
}
