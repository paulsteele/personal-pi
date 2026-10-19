import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SandboxStartupLog } from "../src/sandbox/startup-log.ts";
import { SandboxStartupUI } from "../src/sandbox/startup-ui.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function logFixture() {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-startup-log-"));
  directories.push(directory);
  const logs = join(directory, "logs");
  const notify = vi.fn();
  const context = { mode: "print", hasUI: false, ui: { notify } } as unknown as ExtensionContext;
  const ui = new SandboxStartupUI(
    () => context,
    () => logs,
  );
  return { directory, logs, notify, ui };
}

it("records headless and nested work without truncating long output or creating a second log", async () => {
  const fixture = await logFixture();
  const longOutput = "build-output-".repeat(1000);
  await fixture.ui.run("Starting", async (progress) => {
    progress.stage("Resolving tools");
    progress.output(longOutput);
    progress.diagnostic?.('podman inspect stdout: {"History":[]}');
    await fixture.ui.run("Nested", async (nestedProgress) => {
      expect(nestedProgress).toBe(progress);
      nestedProgress.stage("Running lifecycle hooks");
    });
  });
  expect(await readdir(fixture.logs)).toHaveLength(1);
  const entries = (await readFile(fixture.ui.latestLogPath!, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries.map((entry) => entry.event)).toEqual([
    "start",
    "stage",
    "output",
    "diagnostic",
    "stage",
    "success",
  ]);
  expect(entries[2].text).toBe(longOutput);
  expect(entries[3].text).toContain('podman inspect stdout: {"History":[]}');
  expect((await stat(fixture.logs)).mode & 0o777).toBe(0o700);
  expect((await stat(fixture.ui.latestLogPath!)).mode & 0o777).toBe(0o600);
  expect(fixture.notify).not.toHaveBeenCalled();
});

it("retains a failed operation's output and creates a separate log for the next attempt", async () => {
  const fixture = await logFixture();
  await expect(
    fixture.ui.run("Rebuilding", async (progress) => {
      progress.output("compiler failed\n");
      throw new Error("Build failed");
    }),
  ).rejects.toThrow("Build failed");
  const failedPath = fixture.ui.latestLogPath!;
  const failedEntries = (await readFile(failedPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(failedEntries.at(-1)).toMatchObject({ event: "failure", text: "Error: Build failed" });
  await fixture.ui.run("Retrying", async () => "ready");
  expect(fixture.ui.latestLogPath).not.toBe(failedPath);
  expect(await readdir(fixture.logs)).toHaveLength(2);
});

it("reports unavailable log storage without blocking sandbox work", async () => {
  const fixture = await logFixture();
  await symlink(fixture.directory, fixture.logs);
  const operation = vi.fn(async () => "ready");
  expect(await fixture.ui.run("Starting", operation)).toBe("ready");
  expect(operation).toHaveBeenCalledOnce();
  expect(fixture.ui.latestLogPath).toBeUndefined();
  expect(fixture.notify).toHaveBeenCalledWith(
    expect.stringContaining("Sandbox diagnostic log unavailable"),
    "warning",
  );
});

it("reports a write failure once and leaves subsequent progress nonblocking", async () => {
  const fixture = await logFixture();
  const warning = vi.fn();
  const log = (await SandboxStartupLog.create(fixture.logs, warning))!;
  log.close();
  log.record("output", "cannot write to a closed descriptor");
  log.record("output", "still nonblocking");
  expect(warning).toHaveBeenCalledOnce();
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("diagnostic log write failed"));
});

it("keeps only the newest 25 startup logs for a session", async () => {
  const fixture = await logFixture();
  await mkdir(fixture.logs, { recursive: true });
  const olderLogNames = Array.from(
    { length: 30 },
    (_, index) => `2026-10-01T00-00-${String(index).padStart(2, "0")}.000Z-old.jsonl`,
  );
  for (const name of olderLogNames) {
    await writeFile(join(fixture.logs, name), "{}\n");
  }
  const log = (await SandboxStartupLog.create(fixture.logs, vi.fn()))!;
  log.close();
  const remaining = (await readdir(fixture.logs)).sort();
  expect(remaining).toHaveLength(25);
  expect(remaining).toContain(olderLogNames.at(-1));
  expect(remaining).not.toContain(olderLogNames[0]);
  expect(remaining.at(-1)).toBe(log.path.split("/").at(-1));
});
