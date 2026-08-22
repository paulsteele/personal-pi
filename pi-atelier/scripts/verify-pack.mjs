import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
if (result.status !== 0) {
	process.stderr.write(result.stderr);
	process.exit(result.status ?? 1);
}
const report = JSON.parse(result.stdout)[0];
const names = report.files.map((file) => file.path);
const required = [
	"extensions/index.ts",
	"src/metrics.ts",
	"src/footer.ts",
	"src/state.ts",
	"src/palette.ts",
	"src/run-activity.ts",
	"src/sidebar-panels.ts",
	"src/plannotator.ts",
	"CHANGELOG.md",
	"FORK.md",
	"README.md",
	"LICENSE",
];
const forbidden = ["node_modules", "tests/", "docs/", ".git/", ".pi-subagents", "demo.mp4"];
for (const path of required) {
	if (!names.includes(path)) throw new Error(`Missing package file: ${path}`);
}
for (const prefix of forbidden) {
	if (names.some((name) => name.startsWith(prefix))) throw new Error(`Forbidden package path: ${prefix}`);
}
console.log(`Package contents verified (${names.length} files)`);
