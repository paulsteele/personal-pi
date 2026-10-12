import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"], {
	cwd: new URL(".", import.meta.url),
	encoding: "utf8",
});
if (result.status !== 0) {
	throw new Error(result.stderr || "Package inspection failed");
}
const files = new Set(JSON.parse(result.stdout)[0].files.map((entry) => entry.path));
for (const required of ["index.ts", "README.md", "package.json"]) {
	if (!files.has(required)) {
		throw new Error(`Missing packaged file: ${required}`);
	}
}
for (const file of files) {
	if (/\.test\.|vitest|biome|tsconfig|verify-pack|node_modules/.test(file)) {
		throw new Error(`Unexpected development file: ${file}`);
	}
}
console.log(`Project location package contents verified (${files.size} files)`);
