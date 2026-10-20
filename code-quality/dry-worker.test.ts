import { spawn } from "node:child_process";
import { runFixtureGit } from "../tests/git-fixture.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_DRY_PROFILE } from "./dry-profile.js";

const worker = await import("./dry-worker.mjs" as string);
const mcp = await import("./dry-mcp.mjs" as string);
const corpus = await import("./dry-corpus.mjs" as string);
const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});
async function fakeJscpd(root: string) {
	const executable = join(root, "fake-jscpd");
	const serverScript = await readFile(new URL("./test-fixtures/dry-mcp-server.cjs", import.meta.url), "utf8");
	await writeFile(executable, `#!/usr/bin/env node\n${serverScript}`, { mode: 0o700 });
	return executable;
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "dry-worker-test-"));
	directories.push(root);
	const repo = join(root, "repo");
	await mkdir(repo);
	const directory = await mkdtemp(join(tmpdir(), "pi-quality-dry-"));
	directories.push(directory);
	const options = {
		version: 1,
		root: repo,
		directory,
		profile: DEFAULT_DRY_PROFILE,
		supported: ["typescript", "json"],
		maxFileBytes: 262144,
		timeoutMs: 5000,
		excludedNames: ["bun.lock"],
		generatedSuffixes: [".generated.ts"],
	};
	return { root, repo, options };
}
it("stages owned code and derived features without secrets, documents, or generated output", async () => {
	const h = await fixture();
	await writeFile(join(h.repo, "source.ts"), "const retentionDays = 30;\n");
	await writeFile(join(h.repo, "README.md"), "example");
	await writeFile(join(h.repo, "secret.ts"), `const token = 'ghp_${"a".repeat(25)}';`);
	await writeFile(join(h.repo, "output.generated.ts"), "generated");
	const manifest = await worker.capture(h.options);
	expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(["source.ts"]);
	expect(manifest.excluded).toEqual(
		expect.arrayContaining([
			{ path: "README.md", reason: "unsupported/document" },
			{ path: "secret.ts", reason: "sensitive content" },
			{ path: "output.generated.ts", reason: "generated/lock file" },
		]),
	);
	const indexed = JSON.parse(await readFile(join(h.options.directory, "index", "source.ts.json"), "utf8"));
	expect(indexed).not.toHaveProperty("text");
	expect(indexed).not.toHaveProperty("fragment");
});
async function gitRepository(
	repo: string,
	tracked: Record<string, string>,
	untracked: Record<string, string>,
) {
	for (const [path, text] of Object.entries({ ...tracked, ...untracked })) {
		await mkdir(join(repo, path, ".."), { recursive: true });
		await writeFile(join(repo, path), text);
	}
	await runFixtureGit(repo, ["init", "--quiet"]);
	await runFixtureGit(repo, ["add", "--", ...Object.keys(tracked)]);
}
it("does not discover tracked or untracked files under top-level and nested project exclusions", async () => {
	const h = await fixture();
	await gitRepository(
		h.repo,
		{
			"packages/Vendor/vendor.ts": "const vendored = 1;\n",
			"lib/packages/Nested/nested.ts": "const nested = 1;\n",
			"lib/src/owned.ts": "const owned = 1;\n",
			"src/tracked.ts": "const tracked = 1;\n",
		},
		{
			"packages/Vendor/untracked.ts": "const untrackedVendor = 1;\n",
			"src/untracked.ts": "const untracked = 1;\n",
		},
	);
	const profile = { ...DEFAULT_DRY_PROFILE, exclude: ["packages", "lib/packages/"] };
	const manifest = await worker.capture({ ...h.options, profile });
	const discoveredPaths = [...manifest.files, ...manifest.excluded].map(
		(entry: { path: string }) => entry.path,
	);
	expect(discoveredPaths.sort()).toEqual(["lib/src/owned.ts", "src/tracked.ts", "src/untracked.ts"]);
});
it("skips excluded directories when discovering outside a Git repository", async () => {
	const h = await fixture();
	await mkdir(join(h.repo, "lib", "packages"), { recursive: true });
	await writeFile(join(h.repo, "lib", "packages", "vendor.ts"), "const vendored = 1;\n");
	await writeFile(join(h.repo, "lib", "owned.ts"), "const owned = 1;\n");
	const profile = { ...DEFAULT_DRY_PROFILE, exclude: ["lib/packages"] };
	const manifest = await worker.capture({ ...h.options, profile });
	expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(["lib/owned.ts"]);
	expect(manifest.excluded).toEqual([]);
});
it("records linguist-generated and NuGet package directories as suspects in the manifest", async () => {
	const h = await fixture();
	await gitRepository(
		h.repo,
		{
			".gitattributes": "src/generated/** linguist-generated\n",
			"src/app.ts": "const app = 1;\n",
			"src/generated/api.ts": "const api = 1;\n",
			"internal-packages/Foo/Foo.nuspec": "<package />\n",
			"internal-packages/Foo/content/foo.ts": "const foo = 1;\n",
		},
		{},
	);
	const manifest = await worker.capture(h.options);
	expect(manifest.suspects).toEqual([
		{ directory: "internal-packages", suspectSignal: "1 NuGet package", files: 1, bytes: 15 },
		{ directory: "src/generated", suspectSignal: "linguist-generated", files: 1, bytes: 15 },
	]);
});
it("fails with the corpus size and a working exclusion when sources exceed the byte cap", async () => {
	const h = await fixture();
	await mkdir(join(h.repo, "packages", "Vendor"), { recursive: true });
	await mkdir(join(h.repo, "src"));
	await writeFile(join(h.repo, "packages", "Vendor", "vendor.ts"), `// ${"v".repeat(3000)}\n`);
	await writeFile(join(h.repo, "src", "owned.ts"), `// ${"o".repeat(500)}\n`);
	const profile = { ...DEFAULT_DRY_PROFILE, maxSourceBytes: 1024 };
	const failure = await worker.capture({ ...h.options, profile }).catch((error: Error) => error);
	expect(corpus.parseCorpusError(String(failure))).toEqual({
		kind: "corpus_too_large",
		total: 3508,
		limit: 1024,
		largest: [
			{ directory: "packages/Vendor", weight: 3004 },
			{ directory: "src", weight: 504 },
		],
		suggestedExclude: ["packages/Vendor"],
	});
});
it("fails with the largest directories by file count when discovery exceeds the entry limit", async () => {
	const h = await fixture();
	await mkdir(join(h.repo, "generated"));
	for (let index = 0; index < 101; index++) {
		await writeFile(join(h.repo, "generated", `file${index}.ts`), "const value = 1;\n");
	}
	await gitRepository(h.repo, {}, {});
	const profile = { ...DEFAULT_DRY_PROFILE, entryLimit: 100 };
	const failure = await worker.capture({ ...h.options, profile }).catch((error: Error) => error);
	expect(corpus.parseCorpusError(String(failure))).toMatchObject({
		kind: "discovery_truncated",
		total: 101,
		limit: 100,
		suggestedExclude: ["generated"],
	});
});
it("rebuilds the next baseline and removes deleted staged files", async () => {
	const h = await fixture();
	await writeFile(join(h.repo, "rule.ts"), "const retentionDays = 30;\n");
	const first = await worker.capture(h.options);
	await writeFile(join(h.repo, "rule.ts"), "const retentionDays = 60;\n");
	expect((await worker.capture(h.options)).revision).not.toBe(first.revision);
	await rm(join(h.repo, "rule.ts"));
	expect((await worker.capture(h.options)).files).toEqual([]);
	await expect(readFile(join(h.options.directory, "sources", "rule.ts"))).rejects.toThrow();
});
it("serves current snippets from one immutable baseline without scanning again", async () => {
	const h = await fixture();
	await writeFile(join(h.repo, "existing.ts"), "const retentionDays = 30;");
	const executable = await fakeJscpd(h.root);
	const workerProcess = spawn(process.execPath, [new URL("./dry-worker.mjs", import.meta.url).pathname], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	const workerProcessClosed = new Promise<void>((resolve) => workerProcess.once("close", () => resolve()));
	workerProcess.stdin.end(JSON.stringify({ ...h.options, executable, operation: "serve" }));
	try {
		await mcp.queryBaseline({ ...h.options, operation: "baseline" });
		await writeFile(join(h.repo, "existing.ts"), "const retentionDays = 60;");
		const query = { ...h.options, operation: "query", path: "new.ts", code: "const retentionDays = 30;" };
		const first = await worker.worker(query);
		const second = await worker.worker(query);
		expect(first.clones).toEqual([
			{
				snippet: { path: "new.ts", range: [1, 1] },
				counterpart: { path: "existing.ts", range: [1, 1] },
				kind: "renamed",
				tokens: 40,
			},
		]);
		expect(second.clones).toEqual(first.clones);
		expect(first.file.hash).toBe(worker.hash(query.code));
		expect(JSON.stringify(first)).not.toContain("must not be exported");
		expect(await readFile(join(h.options.directory, "launches"), "utf8")).toBe("scan\n");
		expect(await readFile(join(h.options.directory, "sources", "existing.ts"), "utf8")).toBe(
			"const retentionDays = 30;",
		);
	} finally {
		workerProcess.kill("SIGTERM");
		await workerProcessClosed;
	}
});
it("restages only edited files and removes deleted ones when updating a capture", async () => {
	const h = await fixture();
	await writeFile(join(h.repo, "kept.ts"), "const kept = 1;\n");
	await writeFile(join(h.repo, "edited.ts"), "const edited = 1;\n");
	await writeFile(join(h.repo, "deleted.ts"), "const deleted = 1;\n");
	const first = await worker.capture(h.options);
	const unchanged = await worker.updateCapture(h.options);
	expect(unchanged).toMatchObject({ changed: [], removed: [] });
	expect(unchanged.manifest.revision).toBe(first.revision);

	await writeFile(join(h.repo, "edited.ts"), "const edited = 22;\n");
	await rm(join(h.repo, "deleted.ts"));
	await writeFile(join(h.repo, "added.ts"), "const added = 1;\n");
	const updated = await worker.updateCapture(h.options);
	expect(updated.changed.sort()).toEqual(["added.ts", "edited.ts"]);
	expect(updated.removed).toEqual(["deleted.ts"]);
	expect(updated.manifest.revision).not.toBe(first.revision);
	expect(await readFile(join(h.options.directory, "sources", "edited.ts"), "utf8")).toBe(
		"const edited = 22;\n",
	);
	await expect(readFile(join(h.options.directory, "sources", "deleted.ts"))).rejects.toThrow();
	await expect(readFile(join(h.options.directory, "index", "deleted.ts.json"))).rejects.toThrow();

	const page = await worker.worker({ ...h.options, operation: "index", paths: ["edited.ts"] });
	expect(page.files.map((file: { path: string }) => file.path)).toEqual(["edited.ts"]);
	expect(page.next).toBeNull();
});
it("updates a served baseline in place and rescans only when sources changed", async () => {
	const h = await fixture();
	await writeFile(join(h.repo, "existing.ts"), "const retentionDays = 30;");
	const executable = await fakeJscpd(h.root);
	const workerProcess = spawn(process.execPath, [new URL("./dry-worker.mjs", import.meta.url).pathname], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	const workerProcessClosed = new Promise<void>((resolve) => workerProcess.once("close", () => resolve()));
	workerProcess.stdin.end(JSON.stringify({ ...h.options, executable, operation: "serve" }));
	try {
		await mcp.queryBaseline({ ...h.options, operation: "baseline" });
		const initialManifest = await worker.worker({ ...h.options, operation: "manifest" });
		const unchanged = await worker.worker({ ...h.options, operation: "update" });
		expect(unchanged).toEqual({ revision: initialManifest.revision, changed: [], removed: [] });
		expect(await readFile(join(h.options.directory, "launches"), "utf8")).toBe("scan\n");

		await writeFile(join(h.repo, "existing.ts"), "const retentionDays = 60;");
		const edited = await worker.worker({ ...h.options, operation: "update" });
		expect(edited.changed).toEqual(["existing.ts"]);
		expect(await readFile(join(h.options.directory, "launches"), "utf8")).toBe("scan\nrescan\n");
		const report = JSON.parse(await readFile(join(h.options.directory, "report.json"), "utf8"));
		expect(report.manifestRevision).toBe(edited.revision);
	} finally {
		workerProcess.kill("SIGTERM");
		await workerProcessClosed;
	}
});
it("answers a waiting baseline request with the corpus error before the server exits", async () => {
	const h = await fixture();
	await writeFile(join(h.repo, "existing.ts"), `// ${"x".repeat(2000)}\n`);
	const options = { ...h.options, profile: { ...DEFAULT_DRY_PROFILE, maxSourceBytes: 1024 } };
	const executable = await fakeJscpd(h.root);
	const workerProcess = spawn(process.execPath, [new URL("./dry-worker.mjs", import.meta.url).pathname], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	const workerProcessClosed = new Promise<void>((resolve) => workerProcess.once("close", () => resolve()));
	workerProcess.stdin.end(JSON.stringify({ ...options, executable, operation: "serve" }));
	try {
		await expect(mcp.queryBaseline({ ...options, operation: "baseline" })).rejects.toThrow(
			/DRY_CORPUS_ERROR \{"kind":"corpus_too_large","limit":1024,/,
		);
	} finally {
		workerProcess.kill("SIGTERM");
		await workerProcessClosed;
	}
});
it("delivers a baseline failure even when the client connects before submitting its request", async () => {
	const h = await fixture();
	const failure = corpus.corpusError({ kind: "corpus_too_large", limit: 1024, total: 2004, directories: [] });
	let rejectCapture!: (error: Error) => void;
	const capture = new Promise<never>((_resolve, reject) => {
		rejectCapture = reject;
	});
	const serverClosed = mcp
		.serveBaseline(h.options, () => capture)
		.then(
			() => undefined,
			(error: Error) => error,
		);
	const socket = createConnection(join(h.options.directory, "baseline.sock"));
	const connected = new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	const response = new Promise<string>((resolve, reject) => {
		let reply = "";
		socket.on("data", (bytes) => {
			reply += bytes;
		});
		socket.once("end", () => resolve(reply));
		socket.once("error", reject);
	});
	try {
		await connected;
		rejectCapture(failure);
		await capture.catch(() => {});
		socket.write(`${JSON.stringify({ operation: "baseline" })}\n`);
		expect(JSON.parse(await response)).toEqual({ error: String(failure) });
		expect(await serverClosed).toBe(failure);
	} finally {
		socket.destroy();
	}
});

it("retains an early capture failure until the first baseline request arrives", async () => {
	const h = await fixture();
	const failure = new Error("Capture failed before readiness");
	const capture = Promise.reject(failure);
	const serverClosed = mcp
		.serveBaseline(h.options, () => capture)
		.then(
			() => undefined,
			(error: Error) => error,
		);
	await capture.catch(() => {});
	await expect(mcp.queryBaseline({ ...h.options, operation: "baseline" })).rejects.toThrow(
		"Capture failed before readiness",
	);
	expect(await serverClosed).toBe(failure);
});

it("retires a failed baseline at its request deadline when no client connects", async () => {
	const h = await fixture();
	const failure = new Error("Capture failed without a waiting client");
	await expect(
		mcp.serveBaseline({ ...h.options, timeoutMs: 20 }, () => Promise.reject(failure)),
	).rejects.toBe(failure);
	await expect(readFile(join(h.options.directory, "baseline.sock"))).rejects.toMatchObject({
		code: "ENOENT",
	});
});

it("rejects unsafe or out-of-range snippet results", async () => {
	const manifest = { files: [{ path: "existing.ts", lines: 3 }] };
	const query = { path: "new.ts", code: "a\nb" };
	const duplication = {
		file: "existing.ts",
		fileStartLine: 1,
		fileEndLine: 3,
		snippetStartLine: 1,
		snippetEndLine: 2,
		tokens: 40,
		kind: "exact",
	};
	expect(() =>
		mcp.snippetClones(
			{ count: 1, duplications: [{ ...duplication, file: "../secret.ts" }] },
			query,
			manifest,
		),
	).toThrow("counterpart");
	expect(() =>
		mcp.snippetClones({ count: 1, duplications: [{ ...duplication, snippetEndLine: 3 }] }, query, manifest),
	).toThrow("location");
});
