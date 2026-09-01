import { spawnSync } from "node:child_process";

const expected = new Set([
	"CHANGELOG.md",
	"README.md",
	"config.ts",
	"events.ts",
	"index.ts",
	"observer.ts",
	"package.json",
	"scheduler.ts",
]);
const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
	cwd: new URL(".", import.meta.url),
	encoding: "utf8",
});
if (result.status !== 0) throw new Error(result.stderr || "npm pack failed");
const payload = JSON.parse(result.stdout);
const files = new Set(payload[0]?.files?.map((entry) => entry.path) ?? []);
for (const path of expected) {
	if (!files.has(path)) throw new Error(`Missing packaged file: ${path}`);
}
for (const path of files) {
	if (
		path.endsWith(".test.ts") ||
		path.includes("vitest") ||
		path.includes("biome") ||
		path.includes("tsconfig")
	) {
		throw new Error(`Unexpected development file in package: ${path}`);
	}
}
console.log(`Package contents verified (${files.size} files)`);
