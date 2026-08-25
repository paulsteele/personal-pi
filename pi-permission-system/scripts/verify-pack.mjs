import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
});
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
const report = JSON.parse(result.stdout)[0];
const names = report.files.map((file) => file.path);
const required = [
  "src/index.ts",
  "README.md",
  "FORK.md",
  "CHANGELOG.md",
  "LICENSE",
  "schemas/permissions.schema.json",
];
const forbidden = ["node_modules", "test/", "docs/plans/", "docs/retro/", "logs/", ".git/"];
for (const path of required) {
  if (!names.includes(path)) throw new Error(`Missing package file: ${path}`);
}
for (const prefix of forbidden) {
  if (names.some((name) => name.startsWith(prefix))) {
    throw new Error(`Forbidden package path: ${prefix}`);
  }
}
for (const path of names.filter((name) => name.startsWith("src/") && name.endsWith(".ts"))) {
  const source = readFileSync(path, "utf8");
  if (/#[a-z][a-z0-9_-]*\//i.test(source)) {
    throw new Error(
      `Runtime source contains a package-import alias unsupported by Pi's direct loader: ${path}`,
    );
  }
}
console.log(`Package contents verified (${names.length} files)`);
