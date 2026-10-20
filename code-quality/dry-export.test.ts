import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareBaselineExport, exportHash, exportShardName, EXPORT_SHARD_BYTES } from "./dry-export.mjs";
import { assertBaselineExport, readBaselineExport } from "./dry-export-reader.js";
import { lexicalWindows } from "./dry-lexical.mjs";
import type { DryIndexedFile, DryManifest, DryReport } from "./dry-types.js";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});
async function fixture(sources: Record<string, string>) {
	const directory = await mkdtemp("/tmp/pi-quality-dry-export-test-");
	directories.push(directory);
	const files: DryIndexedFile[] = Object.entries(sources).map(([path, text]) => ({
		path,
		hash: exportHash(Buffer.from(text)),
		bytes: Buffer.byteLength(text),
		lines: text.split("\n").length,
		format: "typescript",
		suppressed: false,
		windows: lexicalWindows(text),
	}));
	const manifest: DryManifest = {
		version: 1,
		revision: exportHash(Buffer.from(JSON.stringify(files))),
		files: files.map(({ windows: _windows, ...metadata }) => metadata),
		bytes: files.reduce((sum, file) => sum + file.bytes, 0),
		excluded: [],
		suspects: [],
		truncated: false,
	};
	const report: DryReport = {
		version: 1,
		manifestRevision: manifest.revision,
		analyzedFiles: files.length,
		cloneCounts: { exact: 0, renamed: 0, gap: 0, ast: 0 },
		formats: [],
		scanDurationMs: 1,
	};
	for (const file of files) {
		const path = join(directory, "index", `${file.path}.json`);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, JSON.stringify(file));
	}
	const reads: string[] = [];
	const ports = {
		read: async (path: string, maxBytes: number) => {
			const bytes = await readFile(path);
			expect(bytes.length).toBeLessThanOrEqual(maxBytes);
			reads.push(path);
			return bytes;
		},
		phase: () => {},
	};
	return { directory, manifest, report, files, reads, ports };
}
function largeLexicalSource() {
	return Array.from({ length: 6000 }, (_, index) => `const property${index} = ${index};`).join("\n");
}
it("reassembles an eligible source whose lexical record exceeds one shard", async () => {
	const source = largeLexicalSource();
	const exportFixture = await fixture({ "large.ts": source });
	expect(Buffer.byteLength(source)).toBeLessThan(262144);
	expect(Buffer.byteLength(JSON.stringify(exportFixture.files[0]))).toBeGreaterThan(EXPORT_SHARD_BYTES);
	const descriptor = await prepareBaselineExport(exportFixture, exportFixture.manifest, exportFixture.report);
	expect(descriptor.artifacts.index.shards).toHaveLength(2);
	const result = await readBaselineExport(
		exportFixture.directory,
		descriptor,
		exportFixture.ports,
		new AbortController().signal,
	);
	expect(result.files).toEqual(exportFixture.files);
	expect(result.manifest).toEqual(exportFixture.manifest);
	expect(result.report).toEqual(exportFixture.report);
});
it("exports a corpus above 16 MiB through bounded filesystem reads only", async () => {
	const source = largeLexicalSource();
	const sources = Object.fromEntries(Array.from({ length: 28 }, (_, index) => [`file-${index}.ts`, source]));
	const exportFixture = await fixture(sources);
	const descriptor = await prepareBaselineExport(exportFixture, exportFixture.manifest, exportFixture.report);
	expect(descriptor.artifacts.index.bytes).toBeGreaterThan(16 * 1024 * 1024);
	expect(descriptor.artifacts.index.shards.every((shard) => shard.bytes <= EXPORT_SHARD_BYTES)).toBe(true);
	const result = await readBaselineExport(
		exportFixture.directory,
		descriptor,
		exportFixture.ports,
		new AbortController().signal,
	);
	expect(result.files).toEqual(exportFixture.files);
	expect(exportFixture.reads.filter((path) => path.includes("index-"))).toHaveLength(
		descriptor.artifacts.index.shards.length,
	);
});
it("exports only changed files while retaining the full manifest", async () => {
	const exportFixture = await fixture({ "kept.ts": "const kept = 1;", "edited.ts": "const updated = 2;" });
	const descriptor = await prepareBaselineExport(
		exportFixture,
		exportFixture.manifest,
		exportFixture.report,
		["edited.ts"],
	);
	const result = await readBaselineExport(
		exportFixture.directory,
		descriptor,
		exportFixture.ports,
		new AbortController().signal,
	);
	expect(result.files.map((file) => file.path)).toEqual(["edited.ts"]);
	expect(result.manifest.files.map((file) => file.path)).toEqual(["kept.ts", "edited.ts"]);
});
it("supports deletion-only updates without lexical reads", async () => {
	const exportFixture = await fixture({ "kept.ts": "const kept = 1;" });
	const descriptor = await prepareBaselineExport(
		exportFixture,
		exportFixture.manifest,
		exportFixture.report,
		[],
	);
	const result = await readBaselineExport(
		exportFixture.directory,
		descriptor,
		exportFixture.ports,
		new AbortController().signal,
	);
	expect(result.files).toEqual([]);
	expect(descriptor.artifacts.index).toEqual({ bytes: 0, shards: [] });
	expect(exportFixture.reads.some((path) => path.includes("index-"))).toBe(false);
});
it("rejects a corrupted shard before accepting the baseline", async () => {
	const exportFixture = await fixture({ "rule.ts": "const retentionDays = 30;" });
	const descriptor = await prepareBaselineExport(exportFixture, exportFixture.manifest, exportFixture.report);
	const shardPath = join(
		exportFixture.directory,
		"exports",
		descriptor.revision,
		exportShardName("index", 0),
	);
	const bytes = await readFile(shardPath);
	bytes[0] = 32;
	await writeFile(shardPath, bytes);
	await expect(
		readBaselineExport(
			exportFixture.directory,
			descriptor,
			exportFixture.ports,
			new AbortController().signal,
		),
	).rejects.toThrow("index shard 0 failed size/hash validation");
});
it("rejects descriptor size and revision mismatches", async () => {
	const exportFixture = await fixture({ "rule.ts": "const retentionDays = 30;" });
	const descriptor = await prepareBaselineExport(exportFixture, exportFixture.manifest, exportFixture.report);
	const wrongSize = {
		...descriptor,
		artifacts: { ...descriptor.artifacts, index: { ...descriptor.artifacts.index, bytes: 1 } },
	};
	expect(() => assertBaselineExport(wrongSize)).toThrow("shard sizes");
	const wrongManifest = { ...exportFixture.manifest, revision: exportHash(Buffer.from("other revision")) };
	const wrongDescriptor = await prepareBaselineExport(exportFixture, wrongManifest, exportFixture.report);
	await expect(
		readBaselineExport(
			exportFixture.directory,
			wrongDescriptor,
			exportFixture.ports,
			new AbortController().signal,
		),
	).rejects.toThrow("report does not match");
});
it("reports the source path and feature location for malformed worker output", async () => {
	const exportFixture = await fixture({ "broken.cs": "const field = 1;" });
	const malformed = {
		...exportFixture.files[0],
		windows: [{ range: [1, 1], features: ["literal:" + "7".repeat(800)] }],
	};
	await writeFile(join(exportFixture.directory, "index", "broken.cs.json"), JSON.stringify(malformed));
	const descriptor = await prepareBaselineExport(exportFixture, exportFixture.manifest, exportFixture.report);
	await expect(
		readBaselineExport(
			exportFixture.directory,
			descriptor,
			exportFixture.ports,
			new AbortController().signal,
		),
	).rejects.toThrow(/broken.cs:.*features/);
});
it("does not accept a cancelled transfer", async () => {
	const exportFixture = await fixture({ "rule.ts": "const retentionDays = 30;" });
	const descriptor = await prepareBaselineExport(exportFixture, exportFixture.manifest, exportFixture.report);
	const abort = new AbortController();
	abort.abort(new Error("retired generation"));
	await expect(
		readBaselineExport(exportFixture.directory, descriptor, exportFixture.ports, abort.signal),
	).rejects.toThrow("retired generation");
});
