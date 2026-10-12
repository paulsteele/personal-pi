import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
});
if (result.status !== 0) {
  throw new Error(result.stderr || "Package inspection failed");
}
const files = new Set(JSON.parse(result.stdout)[0].files.map((file) => file.path));
for (const packagePath of ["index.ts", "storage.ts", "README.md", "package.json"]) {
  if (!files.has(packagePath)) {
    throw new Error(`Missing shared UI package file: ${packagePath}`);
  }
}
for (const packagePath of files) {
  if (/\.test\.|tsconfig|biome|node_modules/.test(packagePath)) {
    throw new Error(`Unexpected shared UI package file: ${packagePath}`);
  }
}
console.log(`Shared UI package contents verified (${files.size} files)`);
