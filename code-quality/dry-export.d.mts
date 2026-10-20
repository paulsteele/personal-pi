import type { DryManifest, DryReport } from "./dry-types.js";
export const EXPORT_SHARD_BYTES: number;
export const MAX_EXPORT_BYTES: number;
export const EXPORT_VERSION: 1;
export function exportHash(bytes: Uint8Array): string;
export function exportShardName(artifact: string, shardIndex: number): string;
export interface DryExportArtifact {
	bytes: number;
	shards: Array<{ bytes: number; hash: string }>;
}
export interface DryBaselineExport {
	version: 1;
	revision: string;
	indexFiles: number;
	artifacts: Record<"manifest" | "report" | "index", DryExportArtifact>;
}
export function prepareBaselineExport(
	options: { directory: string },
	manifest: DryManifest,
	report: DryReport,
	paths?: string[],
): Promise<DryBaselineExport>;
