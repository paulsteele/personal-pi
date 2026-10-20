import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
	cwd: new URL(".", import.meta.url),
	encoding: "utf8",
});
if (result.status !== 0) throw new Error(result.stderr || "npm pack failed");
const files = new Set(JSON.parse(result.stdout)[0].files.map((entry) => entry.path));
for (const required of [
	"index.ts",
	"controller.ts",
	"dry-worker.mjs",
	"dry-mcp.mjs",
	"dry-export.mjs",
	"dry-export.d.mts",
	"dry-export-reader.ts",
	"dry-baseline-deadline.ts",
	"dry-corpus.mjs",
	"dry-suspects.mjs",
	"dry-lexical.mjs",
	"source-disclosure.mjs",
	"dry-policy.md",
	"dry-examples.md",
	"dry-sandbox-manager.ts",
	"dry-worker-schema.ts",
	"dry-check.ts",
	"reviewer-call.ts",
	"activity.ts",
	"feedback.ts",
	"capture.ts",
	"case.ts",
	"state.ts",
	"config.ts",
	"exclusions.ts",
	"reviewer.ts",
	"proposal.ts",
	"ui.ts",
	"lsp-client.ts",
	"lsp-manager.ts",
	"lsp-broker.ts",
	"lsp-workspace-watch.ts",
	"lsp-broker-protocol.ts",
	"lsp-broker-registry.ts",
	"lsp-broker-host.mjs",
	"lsp-process-guard.mjs",
	"lsp-profile.ts",
	"lsp-presets.ts",
	"lsp-setup.ts",
	"lsp-setup-ui.ts",
	"lsp-setup-defaults.ts",
	"lsp-sandbox-setup.ts",
	"lsp-auto-routes.ts",
	"lsp-sandbox-manager.ts",
	"lsp-sandbox-discovery.ts",
	"lsp-sandbox-discovery.py",
	"lsp-install.ts",
	"lsp-commands.ts",
	"lsp-diagnostics.ts",
	"policy.md",
	"examples.md",
	"README.md",
])
	if (!files.has(required)) throw new Error(`Missing packaged file: ${required}`);
for (const path of files)
	if (/\.test\.|vitest|biome|tsconfig|calibrate|dry-scenarios|fixtures\/|lsp-probe/.test(path))
		throw new Error(`Unexpected development file: ${path}`);
console.log(`Quality package contents verified (${files.size} files)`);
