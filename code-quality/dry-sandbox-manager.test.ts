import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SandboxDryManager } from "./dry-sandbox-manager.js";
import type { DryIndexedFile, DryManifest } from "./dry-types.js";
import { DEFAULT_CONFIG } from "./config.js";
import { lexicalWindows } from "./dry-lexical.mjs";

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
async function fixture(baselineSources: Record<string, string> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "dry-manager-"));
	directories.push(directory);
	const root = join(directory, "repo");
	await mkdir(root);
	const files = Object.entries(baselineSources).map(([path, text]) => indexedFile(path, text));
	const manifest: DryManifest = {
		version: 1,
		revision: "a".repeat(64),
		files: files.map(({ windows: _windows, ...metadata }) => metadata),
		excluded: [],
		truncated: false,
		bytes: files.reduce((sum, file) => sum + file.bytes, 0),
	};
	const report = {
		version: 1,
		manifestRevision: manifest.revision,
		cloneCounts: { exact: 0, renamed: 0, gap: 0, ast: 0 },
		analyzedFiles: files.length,
		formats: [{ name: "typescript", files: files.length }],
		scanDurationMs: 1,
	};
	const operations: string[] = [];
	const liveSources = new Map(Object.entries(baselineSources));
	let generation = 1;
	let baselineFailure: string | undefined;
	let finishBaseline: (() => void) | undefined;
	const execute = vi.fn(async (options: { command: string[]; input?: Buffer; signal?: AbortSignal }) => {
		if (!options.input) {
			return { output: Buffer.from("{}"), stderr: "", code: 0 };
		}
		const input = JSON.parse(options.input.toString());
		operations.push(input.operation);
		let value: unknown = {};
		if (input.operation === "serve") {
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
		} else if (input.operation === "manifest") {
			value = manifest;
		} else if (input.operation === "index") {
			value = { files, next: null };
		} else if (input.operation === "query") {
			value = { file: { ...indexedFile(input.path, input.code), windows: [] }, clones: [], retrieved: 0 };
		} else if (input.operation === "evidence") {
			value = {
				text: baselineSources[input.path]!.split("\n")
					.slice(input.range[0] - 1, input.range[1])
					.join("\n"),
			};
		} else if (input.operation === "report") {
			const bytes = Buffer.from(JSON.stringify(report));
			value = { content: bytes.toString("base64"), totalBytes: bytes.length };
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
				mkdir: async () => {},
				write: async () => {},
				canonical: async (path: string) => path,
				stat: async (path: string) => {
					const text = liveSources.get(path.slice(root.length + 1));
					if (text === undefined) {
						throw new Error("FileNotFoundError");
					}
					return { file: true, size: Buffer.byteLength(text) };
				},
				read: async (path: string) => Buffer.from(liveSources.get(path.slice(root.length + 1))!),
			},
			execute,
		},
	};
	const pi = {
		events: { emit: (_name: string, request: { accept(value: unknown): void }) => request.accept(sandbox) },
	};
	const manager = new SandboxDryManager(pi as never, join(directory, "agent"));
	await manager.start(root, true, DEFAULT_CONFIG);
	return {
		manager,
		root,
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
	expect(h.operations.filter((operation) => operation === "serve")).toHaveLength(2);
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
