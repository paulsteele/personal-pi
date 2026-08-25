import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath, saveAutoEnabled } from "#src/config.ts";

describe("config persistence", () => {
  it("creates a missing config from safe defaults", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "permission-config-"));
    saveAutoEnabled(agentDir, false);
    expect(JSON.parse(readFileSync(configPath(agentDir), "utf8"))).toMatchObject({
      permission: { "*": "ask" },
      auto: { enabledByDefault: false },
    });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("refuses to overwrite an invalid permission config", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "permission-config-"));
    const path = configPath(agentDir);
    mkdirSync(join(agentDir, "extensions", "pi-permission-system"), { recursive: true });
    const invalid = '{"permission":{"*":"allow"},"auto":{"provider":"test"}}\n';
    writeFileSync(path, invalid);

    expect(() => saveAutoEnabled(agentDir, false)).toThrow(/Refusing to overwrite invalid/);
    expect(readFileSync(path, "utf8")).toBe(invalid);
    rmSync(agentDir, { recursive: true, force: true });
  });
});
