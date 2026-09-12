// Development-only launcher: resolve installed tools normally, including hoisted workspaces.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
const tools = { vitest: "vitest", tsc: "typescript", biome: "@biomejs/biome" };
const [tool, ...args] = process.argv.slice(2);
if (!Object.hasOwn(tools, tool)) throw new Error("Unknown development tool");
const require = createRequire(import.meta.url);
const manifestPath = require.resolve(`${tools[tool]}/package.json`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[tool];
if (typeof bin !== "string") throw new Error(`Installed ${tools[tool]} has no ${tool} executable`);
const entry = resolve(dirname(manifestPath), bin);
const rel = relative(dirname(manifestPath), entry);
if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\"))
	throw new Error("Invalid installed tool entry");
const result = spawnSync(process.execPath, [entry, ...args], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
