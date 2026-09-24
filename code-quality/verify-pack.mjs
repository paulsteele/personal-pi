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
	"policy.md",
	"examples.md",
	"README.md",
])
	if (!files.has(required)) throw new Error(`Missing packaged file: ${required}`);
for (const path of files)
	if (/\.test\.|vitest|biome|tsconfig|calibrate/.test(path))
		throw new Error(`Unexpected development file: ${path}`);
console.log(`Quality package contents verified (${files.size} files)`);
