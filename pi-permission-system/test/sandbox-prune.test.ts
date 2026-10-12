import { lstat, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inactiveSessionRetentionMs, pruneInactiveSessions } from "../src/sandbox/prune.ts";
import { type SandboxSessionRecord } from "../src/sandbox/session-record.ts";
import { readPrivateText, sha256Hex } from "../src/sandbox/storage.ts";

const podman = vi.hoisted(() => vi.fn());
vi.mock("../src/sandbox/driver.ts", () => ({ podmanOutput: podman }));
const directories: string[] = [];
const nowUnixMs = Date.UTC(2026, 9, 9);
const latestContainer = "a".repeat(64);
const supersededContainer = "b".repeat(64);

afterEach(async () => {
  vi.resetAllMocks();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function pruningFixture(inactiveForMs = inactiveSessionRetentionMs) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sandbox-prune-")));
  directories.push(root);
  const agentDir = join(root, "agent");
  const sessionId = "old-session";
  const directory = join(
    agentDir,
    "extensions",
    "pi-permission-system",
    "sessions",
    sha256Hex(sessionId),
  );
  await mkdir(directory, { recursive: true });
  const hostSource = join(root, "host-file.txt");
  await writeFile(hostSource, "Host files must survive container pruning");
  const record: SandboxSessionRecord = {
    version: 1,
    sessionId,
    startupDirectory: root,
    definitionRevision: "definition",
    generation: 2,
    inactiveSinceUnixMs: nowUnixMs - inactiveForMs,
    mounts: [
      {
        source: hostSource,
        destination: "/host-file.txt",
        access: "ro",
        identity: "1:2",
        kind: "file",
      },
    ],
    environment: {
      container: latestContainer,
      image: "image",
      user: "root",
      workspace: "/workspace",
      configuration: {},
    },
  };
  const recordPath = join(directory, "session.json");
  await writeFile(recordPath, JSON.stringify(record));
  const report = vi.fn();
  podman.mockImplementation(async (args: string[]) => {
    if (args[0] === "ps") {
      return `${latestContainer}\n${supersededContainer}\n`;
    }
    if (args[0] === "inspect") {
      return JSON.stringify([
        {
          Id: args[3],
          Config: { Labels: { "pi.sandbox.session": sessionId } },
          State: { Running: false, Status: "exited" },
        },
      ]);
    }
    return "";
  });
  return {
    agentDir,
    directory,
    recordPath,
    record,
    hostSource,
    report,
    prune: () => pruneInactiveSessions({ agentDir, nowUnixMs, report }),
  };
}

it("removes all stopped generations at seven days and retains authority and host files", async () => {
  const fixture = await pruningFixture();
  await fixture.prune();
  expect(podman).toHaveBeenCalledWith([
    "ps",
    "--all",
    "--no-trunc",
    "--filter",
    "label=pi.sandbox.session=old-session",
    "--format",
    "{{.ID}}",
  ]);
  expect(podman).toHaveBeenCalledWith(["rm", latestContainer]);
  expect(podman).toHaveBeenCalledWith(["rm", supersededContainer]);
  expect(JSON.parse((await readPrivateText(fixture.recordPath))!.text)).toEqual({
    ...fixture.record,
    containerPrunedAtUnixMs: nowUnixMs,
  });
  expect((await readPrivateText(fixture.hostSource))!.text).toBe(
    "Host files must survive container pruning",
  );
  await expect(lstat(join(fixture.directory, "owner.lock"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("keeps a session inactive for less than seven days", async () => {
  const fixture = await pruningFixture(inactiveSessionRetentionMs - 1);
  await fixture.prune();
  expect(podman).not.toHaveBeenCalled();
  expect(JSON.parse((await readPrivateText(fixture.recordPath))!.text)).toEqual(fixture.record);
});

it("does not inspect or prune a session with an ownership lock, even if the lock looks stale", async () => {
  const fixture = await pruningFixture();
  const lockPath = join(fixture.directory, "owner.lock");
  await writeFile(lockPath, '{"pid":99999999}');
  await fixture.prune();
  expect(podman).not.toHaveBeenCalled();
  expect((await readPrivateText(lockPath))!.text).toBe('{"pid":99999999}');
});

it.each([
  { Running: true, Status: "running" },
  { Running: false, Status: "paused" },
])("keeps every generation when one container is not stopped: $Status", async (state) => {
  const fixture = await pruningFixture();
  podman.mockImplementation(async (args: string[]) => {
    if (args[0] === "ps") {
      return `${latestContainer}\n${supersededContainer}\n`;
    }
    return JSON.stringify([
      {
        Id: args[3],
        Config: { Labels: { "pi.sandbox.session": "old-session" } },
        State: args[3] === supersededContainer ? state : { Running: false, Status: "exited" },
      },
    ]);
  });
  await fixture.prune();
  expect(podman.mock.calls.filter(([args]) => args[0] === "rm")).toEqual([]);
  expect(JSON.parse((await readPrivateText(fixture.recordPath))!.text)).toEqual(fixture.record);
});

it("uses the record modification time for sessions saved before inactivity timestamps existed", async () => {
  const fixture = await pruningFixture();
  const { inactiveSinceUnixMs: _inactiveSinceUnixMs, ...legacyRecord } = fixture.record;
  await writeFile(fixture.recordPath, JSON.stringify(legacyRecord));
  const lastSaved = new Date(nowUnixMs - inactiveSessionRetentionMs);
  await utimes(fixture.recordPath, lastSaved, lastSaved);
  await fixture.prune();
  expect(podman).toHaveBeenCalledWith(["rm", latestContainer]);
  expect(JSON.parse((await readPrivateText(fixture.recordPath))!.text).inactiveSinceUnixMs).toBe(
    lastSaved.getTime(),
  );
});

it("refuses a container whose inspected session label does not match", async () => {
  const fixture = await pruningFixture();
  podman.mockResolvedValueOnce(`${latestContainer}\n`).mockResolvedValueOnce(
    JSON.stringify([
      {
        Id: latestContainer,
        Config: { Labels: { "pi.sandbox.session": "another-session" } },
        State: { Running: false, Status: "exited" },
      },
    ]),
  );
  await fixture.prune();
  expect(podman.mock.calls.filter(([args]) => args[0] === "rm")).toEqual([]);
  expect(fixture.report).toHaveBeenCalledWith(expect.stringContaining("another session"));
});

it("retries failed removals on a later sweep without losing the fresh-resume marker", async () => {
  const fixture = await pruningFixture();
  podman.mockImplementationOnce(async () => `${latestContainer}\n`);
  podman.mockImplementationOnce(async () =>
    JSON.stringify([
      {
        Id: latestContainer,
        Config: { Labels: { "pi.sandbox.session": "old-session" } },
        State: { Running: false, Status: "exited" },
      },
    ]),
  );
  podman.mockImplementationOnce(async () => {
    expect(
      JSON.parse((await readPrivateText(fixture.recordPath))!.text).containerPrunedAtUnixMs,
    ).toBe(nowUnixMs);
    throw new Error("Container removal failed");
  });
  await fixture.prune();
  expect(fixture.report).toHaveBeenCalledWith(expect.stringContaining("Container removal failed"));
  expect(
    JSON.parse((await readPrivateText(fixture.recordPath))!.text).containerPrunedAtUnixMs,
  ).toBe(nowUnixMs);
  podman.mockClear();
  await fixture.prune();
  expect(podman).toHaveBeenCalledWith(["rm", latestContainer]);
});

it("skips malformed records without preventing another session from being pruned", async () => {
  const fixture = await pruningFixture();
  const malformedDirectory = join(fixture.directory, "..", "c".repeat(64));
  await mkdir(malformedDirectory);
  await writeFile(join(malformedDirectory, "session.json"), "invalid JSON");
  await fixture.prune();
  expect(podman).toHaveBeenCalledWith(["rm", latestContainer]);
  expect(fixture.report).toHaveBeenCalledWith(
    expect.stringContaining("Could not prune sandbox session"),
  );
  await expect(lstat(join(malformedDirectory, "owner.lock"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
