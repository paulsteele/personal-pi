import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SandboxDryManager } from "./dry-sandbox-manager.js";
import type { DryIndexedFile, DryManifest, DryReport } from "./dry-types.js";
import { DEFAULT_CONFIG } from "./config.js";
import { lexicalWindows } from "./dry-lexical.mjs";
import { corpusError } from "./dry-corpus.mjs";
import { dryProfilePath } from "./dry-profile.js";
import { prepareBaselineExport } from "./dry-export.mjs";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});
const contentHash = (text: string) => createHash("sha256").update(text).digest("hex");
function indexedFile(path: string, text: string): DryIndexedFile {
	const bytes = Buffer.byteLength(text);
	const lines = text.split("\n").length;
	return {
		path,
		hash: contentHash(text),
		format: "typescript",
		bytes,
		lines,
		windows: lexicalWindows(text),
		suppressed: false,
	};
}
async function fixture(
	baselineSources: Record<string, string> = {},
	baselineBudgetMs = DEFAULT_CONFIG.dryScanTimeoutMs,
) {
	const directory = await mkdtemp(join(tmpdir(), "dry-manager-"));
	directories.push(directory);
	const root = join(directory, "repo");
	await mkdir(root);
	const guestCorpus = new Map(Object.entries(baselineSources));
	let files: DryIndexedFile[] = [];
	const manifest: DryManifest = {
		version: 1,
		revision: "",
		files: [],
		excluded: [],
		truncated: false,
		bytes: 0,
		suspects: [] as DryManifest["suspects"],
	};
	const report: DryReport = {
		version: 1,
		manifestRevision: "",
		cloneCounts: { exact: 0, renamed: 0, gap: 0, ast: 0 },
		analyzedFiles: 0,
		formats: [{ name: "typescript", files: 0 }],
		scanDurationMs: 1,
	};
	const stageGuestCorpus = async (guestDirectory: string, isInitialBaseline: boolean) => {
		const previousRevision = manifest.revision;
		const previousHashes = new Map(manifest.files.map((file) => [file.path, file.hash]));
		files = [...guestCorpus].map(([path, text]) => indexedFile(path, text));
		manifest.files = files.map(({ windows: _windows, ...metadata }) => metadata);
		manifest.bytes = files.reduce((sum, file) => sum + file.bytes, 0);
		manifest.revision = contentHash(JSON.stringify([manifest.files, manifest.excluded, manifest.suspects]));
		report.manifestRevision = manifest.revision;
		report.analyzedFiles = files.length;
		report.formats[0]!.files = files.length;
		const changed = files
			.filter((file) => previousHashes.get(file.path) !== file.hash)
			.map((file) => file.path);
		const removed = [...previousHashes.keys()].filter((path) => !guestCorpus.has(path));
		const timings = { captureMs: 1, detectorMs: 1, exportPreparationMs: 1 };
		if (!isInitialBaseline && previousRevision === manifest.revision) {
			return { revision: manifest.revision, changed, removed, timings };
		}
		for (const file of files) {
			const path = join(guestDirectory, "index", `${file.path}.json`);
			await mkdir(join(path, ".."), { recursive: true });
			await writeFile(path, JSON.stringify(file));
		}
		const exportedPaths = isInitialBaseline ? undefined : changed;
		indexRequests.push(exportedPaths);
		const exported = await prepareBaselineExport(
			{ directory: guestDirectory },
			manifest,
			report,
			exportedPaths,
		);
		return { revision: manifest.revision, changed, removed, timings, export: exported };
	};
	const indexRequests: Array<string[] | undefined> = [];
	const operations: string[] = [];
	const liveSources = new Map(Object.entries(baselineSources));
	let generation = 1;
	let baselineFailure: string | undefined;
	let finishBaseline: (() => void) | undefined;
	let ready: Awaited<ReturnType<typeof stageGuestCorpus>>;
	const artifactReads: string[] = [];
	let beforeArtifactRead: ((path: string) => Promise<void>) | undefined;
	const execute = vi.fn(async (options: { command: string[]; input?: Buffer; signal?: AbortSignal }) => {
		if (!options.input) {
			return { output: Buffer.from("{}"), stderr: "", code: 0 };
		}
		const input = JSON.parse(options.input.toString());
		operations.push(input.operation);
		let value: unknown = {};
		if (input.operation === "serve") {
			ready = await stageGuestCorpus(input.directory, true);
			await new Promise<void>((resolve) => {
				if (options.signal?.aborted) {
					resolve();
				} else {
					options.signal?.addEventListener("abort", () => resolve(), { once: true });
				}
			});
		} else if (input.operation === "probe") {
			value = { version: "5.4.1", formats: ["typescript"] };
		} else if (input.operation === "baseline") {
			if (finishBaseline) {
				await new Promise<void>((resolve) => {
					finishBaseline = resolve;
				});
			}
			if (baselineFailure) {
				throw new Error(baselineFailure);
			}
			while (!ready) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			value = ready;
		} else if (input.operation === "update") {
			value = await stageGuestCorpus(input.directory, false);
		} else if (input.operation === "query") {
			value = { file: { ...indexedFile(input.path, input.code), windows: [] }, clones: [], retrieved: 0 };
		} else if (input.operation === "evidence") {
			value = {
				text: baselineSources[input.path]!.split("\n")
					.slice(input.range[0] - 1, input.range[1])
					.join("\n"),
			};
		}
		return { output: Buffer.from(JSON.stringify(value)), stderr: "", code: 0 };
	});
	const sandbox = {
		sessionId: "fixture",
		guestPath: async () => root,
		session: {
			get generation() {
				return generation;
			},
			environment: {
				workspace: root,
				toolInventory: {
					tools: [
						{ id: "jscpd", version: "5.4.1", executable: "/opt/pi-tools/jscpd/5.4.1/bin/jscpd" },
						{
							id: "node-runtime",
							version: "24.21.0",
							executable: "/opt/pi-tools/node-runtime/24.21.0/bin/node",
						},
					],
				},
			},
			filesystem: {
				mkdir: async (path: string) => {
					directories.push(path);
					await mkdir(path, { recursive: true });
				},
				write: async () => {},
				canonical: async (path: string) => path,
				stat: async (path: string) => {
					if (path.startsWith("/tmp/pi-quality-dry-")) {
						const metadata = await stat(path);
						return { file: metadata.isFile(), size: metadata.size };
					}
					const text = liveSources.get(path.slice(root.length + 1));
					if (text === undefined) {
						throw new Error("FileNotFoundError");
					}
					return { file: true, size: Buffer.byteLength(text) };
				},
				read: async (path: string) => {
					if (path.startsWith("/tmp/pi-quality-dry-")) {
						artifactReads.push(path);
						await beforeArtifactRead?.(path);
						return readFile(path);
					}
					return Buffer.from(liveSources.get(path.slice(root.length + 1))!);
				},
			},
			execute,
		},
	};
	const pi = {
		events: { emit: (_name: string, request: { accept(value: unknown): void }) => request.accept(sandbox) },
	};
	const manager = new SandboxDryManager(pi as never, join(directory, "agent"));
	await manager.start(root, true, { ...DEFAULT_CONFIG, dryScanTimeoutMs: baselineBudgetMs });
	return {
		manager,
		root,
		agentDir: join(directory, "agent"),
		guestCorpus,
		indexRequests,
		artifactReads,
		interceptArtifactReads: (intercept: (path: string) => Promise<void>) => {
			beforeArtifactRead = intercept;
		},
		excludeFromBaseline: (entry: { path: string; reason: string }) => {
			manifest.excluded.push(entry);
		},
		reportSuspects: (suspects: DryManifest["suspects"]) => {
			manifest.suspects = suspects;
		},
		operations,
		liveSources,
		execute,
		nextGeneration: () => {
			generation++;
		},
		failBaseline: (reason: string) => {
			baselineFailure = reason;
		},
		holdBaseline: () => {
			finishBaseline = () => {};
		},
		releaseBaseline: () => {
			finishBaseline?.();
			finishBaseline = undefined;
		},
	};
}
it("shares one background baseline across edit chunks and waits for it without another scan", async () => {
	const h = await fixture({ "existing.ts": "const retentionDays = 30;" });
	const signal = new AbortController().signal;
	h.holdBaseline();
	const scanning = h.manager.beginTurn(signal);
	await vi.waitFor(() => expect(h.operations).toContain("baseline"));
	const check = h.manager.prepare(
		[{ path: join(h.root, "new.ts"), before: "", after: "const retentionDays = 30;" }],
		[],
		signal,
	);
	expect(h.operations).not.toContain("query");
	h.releaseBaseline();
	await scanning;
	const prepared = await check;
	expect(prepared.evidence[0]?.changed.hash).toBe(contentHash("const retentionDays = 30;"));
	await h.manager.prepare([], [], signal);
	expect(h.operations.filter((operation) => operation === "serve")).toHaveLength(1);
	expect(h.operations).not.toContain("validate");
	expect(h.operations).not.toContain("metadata");
	const firstTurnGeneration = h.manager.generationId;
	await h.manager.beginTurn(signal);
	expect(h.manager.generationId).not.toBe(firstTurnGeneration);
	expect(h.operations.filter((operation) => operation === "serve")).toHaveLength(1);
	await h.manager.stop();
});
it("keeps the session baseline across turns without exporting anything when nothing changed", async () => {
	const h = await fixture({ "existing.ts": "const retentionDays = 30;" });
	const signal = new AbortController().signal;
	await h.manager.beginTurn(signal);
	const firstRevision = h.manager.revision;
	h.operations.length = 0;
	h.artifactReads.length = 0;
	await h.manager.beginTurn(signal);
	expect(h.operations).toEqual(["update"]);
	expect(h.artifactReads.filter((path) => path.includes("/exports/"))).toEqual([]);
	expect(h.manager.revision).toBe(firstRevision);
	expect(h.manager.status.scanPhase).toBe("ready");
	await h.manager.stop();
});
it("re-indexes only edited files when the next turn updates the baseline", async () => {
	const h = await fixture({ "kept.ts": "const kept = 1;", "edited.ts": "const edited = 1;", "gone.ts": "x" });
	const signal = new AbortController().signal;
	await h.manager.beginTurn(signal);
	h.guestCorpus.set("edited.ts", "const edited = 2;");
	h.guestCorpus.delete("gone.ts");
	h.operations.length = 0;
	h.indexRequests.length = 0;
	await h.manager.beginTurn(signal);
	expect(h.operations).not.toContain("serve");
	expect(h.operations).not.toContain("index");
	expect(h.indexRequests).toEqual([["edited.ts"]]);
	expect(h.manager.files.map((file) => [file.path, file.hash])).toEqual([
		["kept.ts", contentHash("const kept = 1;")],
		["edited.ts", contentHash("const edited = 2;")],
	]);
	expect(h.manager.status).toMatchObject({ scanPhase: "ready", files: 2 });
	await h.manager.stop();
});
it("rebuilds the baseline from scratch on refresh and after a sandbox generation change", async () => {
	const h = await fixture({ "existing.ts": "const retentionDays = 30;" });
	const signal = new AbortController().signal;
	await h.manager.beginTurn(signal);
	await h.manager.refresh(signal);
	expect(h.operations.filter((operation) => operation === "serve")).toHaveLength(2);
	expect(h.operations).not.toContain("update");
	h.nextGeneration();
	await expect(h.manager.beginTurn(signal)).rejects.toThrow("generation changed");
	expect(h.operations).not.toContain("update");
	await h.manager.stop();
});
it.each([
	{ scenario: "changed", sourceText: "const retentionDays = 60;" },
	{ scenario: "deleted", sourceText: undefined },
])("discards a $scenario counterpart without rebuilding the baseline", async ({ sourceText }) => {
	const h = await fixture({ "existing.ts": "const retentionDays = 30;" });
	const signal = new AbortController().signal;
	await h.manager.beginTurn(signal);
	if (sourceText === undefined) {
		h.liveSources.delete("existing.ts");
	} else {
		h.liveSources.set("existing.ts", sourceText);
	}
	const prepared = await h.manager.prepare(
		[{ path: join(h.root, "new.ts"), before: "", after: "const retentionDays = 30;" }],
		[],
		signal,
	);
	expect(prepared.evidence).toEqual([]);
	expect(prepared.coverage[0]).toMatchObject({
		outcome: "no_candidates",
		reason: "Changed or deleted baseline counterparts discarded",
	});
	expect(h.operations.filter((operation) => operation === "serve")).toHaveLength(1);
	await h.manager.stop();
});
it("ignores unrelated repository changes but retires baseline ownership on rebuild", async () => {
	const h = await fixture();
	const signal = new AbortController().signal;
	await h.manager.beginTurn(signal);
	h.liveSources.set("external.ts", "new external content");
	expect(await h.manager.current(signal)).toBe(true);
	h.nextGeneration();
	expect(await h.manager.current(signal)).toBe(false);
	await h.manager.stop();
	expect(h.manager.manifest).toBeUndefined();
});
it("explains an oversized corpus with the profile path and a pasteable exclusion", async () => {
	const h = await fixture();
	const corpusTooLarge = corpusError({
		kind: "corpus_too_large",
		total: 129.4 * 1024 * 1024,
		limit: 32 * 1024 * 1024,
		largest: [
			{ directory: "lib/packages", weight: 106.4 * 1024 * 1024 },
			{ directory: "packages", weight: 18.2 * 1024 * 1024 },
		],
		suggestedExclude: ["lib/packages", "packages"],
	});
	h.failBaseline(String(corpusTooLarge));
	const signal = new AbortController().signal;
	await expect(h.manager.beginTurn(signal)).rejects.toThrow("DRY corpus is 129.4 MiB");
	expect(h.manager.status.scanPhase).toBe("unavailable");
	expect(h.manager.status.reason).toBe(
		[
			"DRY corpus is 129.4 MiB, over the 32.0 MiB limit. Largest directories:",
			"  lib/packages  106.4 MiB",
			"  packages       18.2 MiB",
			`Exclude vendored/generated directories in the DRY project profile (Settings → Code Quality → DRY Checking → Project retrieval profile, or ${dryProfilePath(h.agentDir, h.manager.project!)}), e.g.`,
			'  "exclude": ["lib/packages","packages"]',
			"then run /quality dry refresh.",
		].join("\n"),
	);
	await h.manager.stop();
});
it("publishes a scan with ordinary exclusions as ready", async () => {
	const h = await fixture({ "existing.ts": "const retentionDays = 30;" });
	h.excludeFromBaseline({ path: "node_modules/a.ts", reason: "dependency/build directory" });
	await h.manager.beginTurn(new AbortController().signal);
	expect(h.manager.status).toMatchObject({ scanPhase: "ready", excluded: 1 });
	await h.manager.stop();
});
it("keeps a scan ready while warning about directories that look vendored", async () => {
	const h = await fixture({ "existing.ts": "const retentionDays = 30;" });
	h.reportSuspects([
		{
			directory: "internal-packages",
			suspectSignal: "11 NuGet packages",
			files: 40,
			bytes: 400 * 1024,
		},
		{
			directory: "build/tools/.store",
			suspectSignal: "NuGet tool store",
			files: 3,
			bytes: 100 * 1024,
		},
	]);
	await h.manager.beginTurn(new AbortController().signal);
	expect(h.manager.status.scanPhase).toBe("ready");
	expect(h.manager.status.reason).toBeUndefined();
	expect(h.manager.status.warning).toBe(
		[
			"DRY is scanning directories that look vendored or generated:",
			"  internal-packages   (11 NuGet packages, 0.4 MiB)",
			"  build/tools/.store  (NuGet tool store, 0.1 MiB)",
			`Add them to "exclude" in the DRY project profile (Settings → Code Quality → DRY Checking → Project retrieval profile, or ${dryProfilePath(h.agentDir, h.manager.project!)}), or to "include" to keep scanning them silently.`,
		].join("\n"),
	);
	await h.manager.stop();
});
it("uses a constant worker-launch count for an index larger than 16 MiB", async () => {
	const source = Array.from({ length: 6000 }, (_, index) => `const property${index} = ${index};`).join("\n");
	const sources = Object.fromEntries(Array.from({ length: 28 }, (_, index) => [`file-${index}.ts`, source]));
	const exportFixture = await fixture(sources);
	await exportFixture.manager.beginTurn(new AbortController().signal);
	expect(exportFixture.manager.status.indexBytes).toBeGreaterThan(16 * 1024 * 1024);
	expect(exportFixture.manager.status.indexShards).toBeGreaterThan(32);
	expect(exportFixture.operations).toEqual(["probe", "serve", "baseline"]);
	expect(exportFixture.manager.status.files).toBe(28);
	await exportFixture.manager.stop();
});
it("times out during transfer even when the filesystem ignores cancellation", async () => {
	const exportFixture = await fixture({ "rule.ts": "const retentionDays = 30;" }, 100);
	exportFixture.interceptArtifactReads(async (path) => {
		if (path.includes("index-")) {
			await new Promise<void>(() => {});
		}
	});
	await expect(exportFixture.manager.beginTurn(new AbortController().signal)).rejects.toThrow(
		"timed out during index transfer/validation",
	);
	expect(exportFixture.manager.status.scanPhase).toBe("unavailable");
	expect(exportFixture.manager.files).toEqual([]);
	await exportFixture.manager.stop();
});
it("rejects a generation retired while a shard is in flight", async () => {
	const exportFixture = await fixture({ "rule.ts": "const retentionDays = 30;" });
	exportFixture.interceptArtifactReads(async (path) => {
		if (path.includes("index-")) {
			exportFixture.nextGeneration();
		}
	});
	await expect(exportFixture.manager.beginTurn(new AbortController().signal)).rejects.toThrow(
		"retired sandbox/worker",
	);
	expect(exportFixture.manager.status.scanPhase).toBe("unavailable");
	await exportFixture.manager.stop();
});
it("does not retry a failed scan from edit checks within the same turn", async () => {
	const h = await fixture();
	h.failBaseline("Scanner unavailable");
	const signal = new AbortController().signal;
	await expect(h.manager.beginTurn(signal)).rejects.toThrow("Scanner unavailable");
	await expect(h.manager.prepare([], [], signal)).rejects.toThrow("Scanner unavailable");
	await expect(h.manager.prepare([], [], signal)).rejects.toThrow("Scanner unavailable");
	expect(h.operations.filter((operation) => operation === "serve")).toHaveLength(1);
	await h.manager.stop();
});
