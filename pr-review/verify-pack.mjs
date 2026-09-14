import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"], {
	cwd: new URL(".", import.meta.url),
	encoding: "utf8",
});
if (result.status !== 0) throw new Error(result.stderr || "Package inspection failed");
const files = new Set(JSON.parse(result.stdout)[0].files.map((entry) => entry.path));
for (const path of [
	"index.ts",
	"worker.ts",
	"runner.ts",
	"snapshot.ts",
	"plannotator.ts",
	"plannotator-host.mjs",
	"viewer-patch.mjs",
	"host-loader.mjs",
	"handoff.ts",
	"batching.ts",
	"blob-cache.ts",
	"planning.ts",
	"tasks.ts",
	"dashboard.ts",
	"journal.ts",
	"worker-context.ts",
	"snapshot-store.ts",
	"snapshot-diff.mjs",
	"README.md",
	"package.json",
])
	if (!files.has(path)) throw new Error(`Missing packaged file: ${path}`);
for (const directory of ["prompts", "prompts/personas"])
	for (const path of readdirSync(new URL(`./${directory}/`, import.meta.url)))
		if (path.endsWith(".md") && !files.has(`${directory}/${path}`))
			throw new Error(`Missing prompt: ${path}`);
for (const path of files)
	if (
		/\.test\.|compatibility|test-fixtures|vitest|biome|tsconfig|verify-pack|node_modules|profile\.json|reports\//.test(
			path,
		)
	)
		throw new Error(`Unexpected packaged file: ${path}`);
console.log(`PR review package contents verified (${files.size} files)`);
