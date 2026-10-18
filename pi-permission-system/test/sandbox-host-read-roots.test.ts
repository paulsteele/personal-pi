import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { reviewSandboxToolCall } from "../src/sandbox/gate.ts";
import { hostReadablePath } from "../src/sandbox/host-read-roots.ts";
import { parseSandboxSettings, saveSandboxSettings } from "../src/sandbox/settings.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function agentDirFixture() {
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "sandbox-host-read-")));
  directories.push(agentDir);
  const transcript = join(agentDir, "sessions", "--project--", "session.jsonl");
  const reviewConfig = join(agentDir, "extensions", "pr-review", "config.json");
  const sandboxStorageFile = join(
    agentDir,
    "extensions",
    "pi-permission-system",
    "global",
    "tools.json",
  );
  const nestedExtensionFile = join(agentDir, "extensions", "pr-review", "repos", "config.json");
  const sandboxSessionDirectory = join(
    agentDir,
    "extensions",
    "pi-permission-system",
    "sessions",
    "a1b2",
  );
  const startupLogs = join(sandboxSessionDirectory, "startup-logs");
  const startupLog = join(startupLogs, "2026-10-18T17-17-44.000Z-id.jsonl");
  const sessionRecord = join(sandboxSessionDirectory, "session.json");
  const guestTimingLog = join(sandboxSessionDirectory, "guest-timing.jsonl");
  for (const path of [
    transcript,
    reviewConfig,
    sandboxStorageFile,
    nestedExtensionFile,
    startupLog,
    sessionRecord,
    guestTimingLog,
  ]) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{}");
  }
  await writeFile(join(agentDir, "auth.json"), "{}");
  return {
    agentDir,
    transcript,
    reviewConfig,
    sandboxStorageFile,
    nestedExtensionFile,
    startupLogs,
    startupLog,
    sessionRecord,
    guestTimingLog,
  };
}

const sandboxReadTool = {
  name: "read",
  sourceInfo: { path: "/installed/pi-permission-system/src/index.ts" },
} as ToolInfo;

it("allows Pi's own package documentation", async () => {
  const { agentDir } = await agentDirFixture();
  const readme = join(getPackageDir(), "README.md");
  expect(await hostReadablePath(readme, agentDir)).toBe(await realpath(readme));
  expect(await hostReadablePath(join(getPackageDir(), "docs"), agentDir)).toBeDefined();
});

it("allows session transcripts and other extensions' config files", async () => {
  const fixture = await agentDirFixture();
  expect(await hostReadablePath(fixture.transcript, fixture.agentDir)).toBe(fixture.transcript);
  expect(await hostReadablePath(fixture.reviewConfig, fixture.agentDir)).toBe(fixture.reviewConfig);
});

it("allows sandbox startup log directories and their JSONL logs", async () => {
  const fixture = await agentDirFixture();
  expect(await hostReadablePath(fixture.startupLogs, fixture.agentDir)).toBe(fixture.startupLogs);
  expect(await hostReadablePath(fixture.startupLog, fixture.agentDir)).toBe(fixture.startupLog);
});

it("refuses other sandbox session files beside the startup logs", async () => {
  const fixture = await agentDirFixture();
  expect(await hostReadablePath(fixture.sessionRecord, fixture.agentDir)).toBeUndefined();
  expect(await hostReadablePath(fixture.guestTimingLog, fixture.agentDir)).toBeUndefined();
  const sandboxSessions = join(fixture.agentDir, "extensions", "pi-permission-system", "sessions");
  expect(await hostReadablePath(sandboxSessions, fixture.agentDir)).toBeUndefined();
  const escape = join(fixture.startupLogs, "..", "session.json");
  expect(await hostReadablePath(escape, fixture.agentDir)).toBeUndefined();
});

it("refuses sandbox authority storage, credentials, and other extension files", async () => {
  const fixture = await agentDirFixture();
  expect(await hostReadablePath(fixture.sandboxStorageFile, fixture.agentDir)).toBeUndefined();
  expect(
    await hostReadablePath(join(fixture.agentDir, "auth.json"), fixture.agentDir),
  ).toBeUndefined();
  expect(await hostReadablePath(fixture.nestedExtensionFile, fixture.agentDir)).toBeUndefined();
});

it("refuses relative paths and paths that escape a root through '..'", async () => {
  const fixture = await agentDirFixture();
  expect(await hostReadablePath("sessions/x.jsonl", fixture.agentDir)).toBeUndefined();
  const escape = join(fixture.agentDir, "sessions", "..", "auth.json");
  expect(await hostReadablePath(escape, fixture.agentDir)).toBeUndefined();
});

it("reviews a Pi documentation read on the host without touching the sandbox", async () => {
  const { agentDir } = await agentDirFixture();
  const getSession = vi.fn(() => {
    throw new Error("Mandatory sandbox is unavailable");
  });
  await reviewSandboxToolCall({
    tool: sandboxReadTool,
    getSession,
    agentDir,
    input: { path: join(getPackageDir(), "README.md") },
    ctx: { cwd: agentDir } as never,
  });
  expect(getSession).not.toHaveBeenCalled();
});

it("still applies explicit path denies to host-routed reads", async () => {
  const fixture = await agentDirFixture();
  await saveSandboxSettings(
    fixture.agentDir,
    parseSandboxSettings({ permission: { path: { "*/sessions/*": "deny" } } }),
    undefined,
  );
  await expect(
    reviewSandboxToolCall({
      tool: sandboxReadTool,
      getSession: () => {
        throw new Error("unused");
      },
      agentDir: fixture.agentDir,
      input: { path: fixture.transcript },
      ctx: { cwd: fixture.agentDir } as never,
    }),
  ).rejects.toThrow("Path denied by explicit policy");
});
