import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_DRY_PROFILE } from "./dry-profile.js";

const worker = await import("./dry-worker.mjs" as string);
const mcp = await import("./dry-mcp.mjs" as string);
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
