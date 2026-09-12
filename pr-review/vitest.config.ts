import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
const agentDir = mkdtempSync(join(tmpdir(), "pr-review-vitest-"));
process.once("exit", () => rmSync(agentDir, { recursive: true, force: true }));
export default defineConfig({ test: { include: ["*.test.ts"], env: { PI_CODING_AGENT_DIR: agentDir } } });
