// Explicit human UI smoke test. Synthetic data only; never calls a model or applies fixes.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHostLoader } from "./host-loader.mjs";
const piPackageDir = process.env.PR_REVIEW_TEST_PI_PACKAGE;
const plannotatorDir = process.env.PR_REVIEW_TEST_PLANNOTATOR_PACKAGE;
if (!piPackageDir || !plannotatorDir)
	throw new Error(
		"Provide the two existing installation paths through PR_REVIEW_TEST_* environment variables. Nothing is installed automatically.",
	);
const loader = createHostLoader(piPackageDir);
const { present } = await loader.import(fileURLToPath(new URL("./plannotator.ts", import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), "pr-review-manual-smoke-"));
const root = join(temp, "agent", "extensions", "pr-review");
await mkdir(root, { recursive: true, mode: 0o700 });
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const id = randomUUID();
const repoId = createHash("sha256").update("synthetic smoke").digest("hex");
const patch =
	"diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1,4 +1,4 @@\n-export const enabled = false;\n+export const enabled = true;\n export function count(items: string[]) {\n-  return items.length;\n+  return items.length + 1;\n }\n";
const snapshot = {
	repo: { root: join(temp, "synthetic-repo"), commonDir: join(temp, "synthetic-repo", ".git"), id: repoId },
	head: null,
	baseline: null,
	fingerprint: "synthetic-fixture",
	omitted: [],
	changes: [
		{
			file: "demo.ts",
			oldPath: "demo.ts",
			patch,
			added: [],
			removed: [],
			oldLines: new Set([1, 3]),
			newLines: new Set([1, 3]),
			metadataOnly: false,
		},
	],
};
const finding = (id, line, title) => ({
	id,
	reviewer: "Synthetic reviewer",
	title,
	severity: "low",
	file: "demo.ts",
	side: "new",
	startLine: line,
	endLine: line,
	problem: "Synthetic UI test only — this is not a real code review finding.",
	suggestion: "No files will be edited. Keep F1 and remove F2 before sending feedback.",
	rationale: "Verify annotation identity and browser submission routing.",
	evidence: [
		{
			file: "demo.ts",
			side: "new",
			line,
			quote: line === 1 ? "export const enabled = true;" : "  return items.length + 1;",
		},
	],
});
const report = {
	version: 1,
	id,
	repoId,
	project: "SYNTHETIC TEST — no fixes will be applied",
	createdAt: new Date().toISOString(),
	scope: { kind: "local" },
	baseline: null,
	head: null,
	fingerprint: "synthetic-fixture",
	profileHash: "fixture",
	promptHashes: {},
	model: "none — no model calls",
	status: "complete",
	lenses: [],
	declined: [],
	clean: [],
	issues: [],
	omitted: [],
	changedFiles: 1,
	findings: [
		finding("F1", 1, "Keep this demonstration comment"),
		finding("F2", 3, "Remove this demonstration comment"),
	],
	groups: [["F1"], ["F2"]],
	ledger: [],
	elapsedMs: 0,
	usage: { input: 0, output: 0, cost: 0 },
};
try {
	console.log(
		"Synthetic UI test: remove F2, leave F1 unchanged, then Send Feedback. No fixes will be applied.",
	);
	const result = await present({
		root,
		piPackageDir,
		plannotatorDir,
		report,
		snapshot,
		signal: controller.signal,
		progress: console.log,
	});
	console.log("SYNTHETIC RESULT ONLY:", JSON.stringify(result, null, 2));
	console.log(
		result.decision === "feedback" && JSON.stringify(result.requestedIds) === '["F1"]'
			? "BROWSER SMOKE PASSED: only F1 requested."
			: "Browser outcome differs from the requested test action; inspect result.",
	);
} finally {
	await rm(temp, { recursive: true, force: true });
}
