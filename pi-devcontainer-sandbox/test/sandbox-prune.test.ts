import { lstat, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sessionImageName } from "../src/sandbox/container-identity.ts";
import { inactiveSessionRetentionMs, pruneInactiveSessions } from "../src/sandbox/prune.ts";
import { type SandboxSessionRecord } from "../src/sandbox/session-record.ts";
import { readPrivateText, sha256Hex } from "../src/sandbox/storage.ts";

const podman = vi.hoisted(() => vi.fn());
vi.mock("../src/sandbox/driver.ts", () => ({ podmanOutput: podman }));
const directories: string[] = [];
const nowUnixMs = Date.UTC(2026, 9, 9);
const exitedProcessPid = 2 ** 22 + 12345;
const abandonedContainer = "a".repeat(64);
const liveContainer = "b".repeat(64);

afterEach(async () => {
  vi.resetAllMocks();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

interface EngineState {
  containers: Array<{ id: string; sessionId: string }>;
  images: string[];
}

async function sessionDirectory(agentDir: string, sessionId: string): Promise<string> {
  const directory = join(
    agentDir,
    "extensions",
    "pi-devcontainer-sandbox",
    "sessions",
    sha256Hex(sessionId),
  );
  await mkdir(directory, { recursive: true });
  return directory;
}

function sessionRecord(sessionId: string, startupDirectory: string): SandboxSessionRecord {
  return {
    version: 1,
    sessionId,
    startupDirectory,
    definitionRevision: "definition",
    generation: 2,
    mounts: [],
    environment: {
      container: abandonedContainer,
      image: "image",
      user: "root",
      workspace: "/workspace",
      configuration: {},
    },
  };
}

async function pruningFixture(engine: EngineState) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sandbox-prune-")));
  directories.push(root);
  const agentDir = join(root, "agent");
  const report = vi.fn();
  podman.mockImplementation(async (args: string[]) => {
    if (args[0] === "ps") {
      expect(args.slice(-2)).toEqual(["--format", "json"]);
      return JSON.stringify(
        engine.containers.map(({ id, sessionId }) => ({
          Id: id,
          Labels: { "pi.sandbox.session": sessionId, "pi.sandbox.generation": "1" },
        })),
      );
    }
    if (args[0] === "images") {
      return engine.images.map((image) => `${image}\n`).join("");
    }
    return "";
  });
  return {
    root,
    agentDir,
    report,
    prune: () => pruneInactiveSessions({ agentDir, nowUnixMs, report }),
  };
}

it("removes containers of sessions without a live owner and marks their records disposed", async () => {
  const fixture = await pruningFixture({
    containers: [{ id: abandonedContainer, sessionId: "abandoned-session" }],
    images: [],
  });
  const directory = await sessionDirectory(fixture.agentDir, "abandoned-session");
  const recordPath = join(directory, "session.json");
  const record = sessionRecord("abandoned-session", fixture.root);
  await writeFile(recordPath, JSON.stringify(record));
  await fixture.prune();
  expect(podman).toHaveBeenCalledWith(["rm", "--force", "--time=0", abandonedContainer]);
  expect(JSON.parse((await readPrivateText(recordPath))!.text)).toEqual({
    ...record,
    inactiveSinceUnixMs: nowUnixMs,
    containerPrunedAtUnixMs: nowUnixMs,
  });
  await expect(lstat(join(directory, "owner.lock"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("removes orphaned containers whose failed start never saved a session record", async () => {
  const fixture = await pruningFixture({
    containers: [{ id: abandonedContainer, sessionId: "failed-start-session" }],
    images: [],
  });
  await sessionDirectory(fixture.agentDir, "failed-start-session");
  await fixture.prune();
  expect(podman).toHaveBeenCalledWith(["rm", "--force", "--time=0", abandonedContainer]);
});

it("keeps the container and images of a session whose owner process is running", async () => {
  const liveImage = `${sessionImageName("live-session")}:latest`;
  const fixture = await pruningFixture({
    containers: [{ id: liveContainer, sessionId: "live-session" }],
    images: [liveImage],
  });
  const directory = await sessionDirectory(fixture.agentDir, "live-session");
  await writeFile(join(directory, "owner.lock"), JSON.stringify({ pid: process.pid }));
  await fixture.prune();
  expect(podman).not.toHaveBeenCalledWith(["rm", "--force", "--time=0", liveContainer]);
  expect(podman).not.toHaveBeenCalledWith(["rmi", liveImage]);
});

it("treats an owner lock left by an exited process as abandoned", async () => {
  const fixture = await pruningFixture({
    containers: [{ id: abandonedContainer, sessionId: "crashed-session" }],
    images: [],
  });
  const directory = await sessionDirectory(fixture.agentDir, "crashed-session");
  await writeFile(join(directory, "owner.lock"), JSON.stringify({ pid: exitedProcessPid }));
  await fixture.prune();
  expect(podman).toHaveBeenCalledWith(["rm", "--force", "--time=0", abandonedContainer]);
});

it("removes session and checkpoint images that belong to no live session", async () => {
  const abandonedImage = `${sessionImageName("abandoned-session")}:latest`;
  const abandonedCheckpoint = `${sessionImageName("abandoned-session")}-checkpoint:g3`;
  const liveImage = `${sessionImageName("live-session")}:latest`;
  const fixture = await pruningFixture({
    containers: [],
    images: [abandonedImage, abandonedCheckpoint, liveImage, "localhost/pi-project:shared"],
  });
  const liveDirectory = await sessionDirectory(fixture.agentDir, "live-session");
  await writeFile(join(liveDirectory, "owner.lock"), JSON.stringify({ pid: process.pid }));
  await fixture.prune();
  expect(podman).toHaveBeenCalledWith(["rmi", abandonedImage]);
  expect(podman).toHaveBeenCalledWith(["rmi", abandonedCheckpoint]);
  expect(podman).not.toHaveBeenCalledWith(["rmi", liveImage]);
  expect(podman).not.toHaveBeenCalledWith(["rmi", "localhost/pi-project:shared"]);
});

it("keeps the session image of a recently closed session so reopening reuses its build", async () => {
  const closedImage = `${sessionImageName("closed-session")}:latest`;
  const closedCheckpoint = `${sessionImageName("closed-session")}-checkpoint:g3`;
  const fixture = await pruningFixture({ containers: [], images: [closedImage, closedCheckpoint] });
  const directory = await sessionDirectory(fixture.agentDir, "closed-session");
  const closedRecord = {
    ...sessionRecord("closed-session", fixture.root),
    inactiveSinceUnixMs: nowUnixMs - inactiveSessionRetentionMs + 1000,
  };
  await writeFile(join(directory, "session.json"), JSON.stringify(closedRecord));
  await fixture.prune();
  expect(podman).not.toHaveBeenCalledWith(["rmi", closedImage]);
  expect(podman).toHaveBeenCalledWith(["rmi", closedCheckpoint]);
});

it("removes the session image of a session closed for seven days", async () => {
  const expiredImage = `${sessionImageName("expired-session")}:latest`;
  const fixture = await pruningFixture({ containers: [], images: [expiredImage] });
  const directory = await sessionDirectory(fixture.agentDir, "expired-session");
  const expiredRecord = {
    ...sessionRecord("expired-session", fixture.root),
    inactiveSinceUnixMs: nowUnixMs - inactiveSessionRetentionMs,
  };
  await writeFile(join(directory, "session.json"), JSON.stringify(expiredRecord));
  await fixture.prune();
  expect(podman).toHaveBeenCalledWith(["rmi", expiredImage]);
});

it("deletes failed-start directories without a record after seven days", async () => {
  const fixture = await pruningFixture({ containers: [], images: [] });
  const expired = await sessionDirectory(fixture.agentDir, "expired-failed-start");
  const recent = await sessionDirectory(fixture.agentDir, "recent-failed-start");
  const expiredAt = new Date(nowUnixMs - inactiveSessionRetentionMs);
  await utimes(expired, expiredAt, expiredAt);
  const recentAt = new Date(nowUnixMs - inactiveSessionRetentionMs + 1000);
  await utimes(recent, recentAt, recentAt);
  await fixture.prune();
  await expect(lstat(expired)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(recent)).isDirectory()).toBe(true);
});

it("keeps a saved session record even when its container was removed", async () => {
  const fixture = await pruningFixture({ containers: [], images: [] });
  const directory = await sessionDirectory(fixture.agentDir, "resumable-session");
  const recordPath = join(directory, "session.json");
  await writeFile(recordPath, JSON.stringify(sessionRecord("resumable-session", fixture.root)));
  const expiredAt = new Date(nowUnixMs - inactiveSessionRetentionMs);
  await utimes(directory, expiredAt, expiredAt);
  await fixture.prune();
  expect(await readPrivateText(recordPath)).toBeDefined();
});

it("reports a failed removal and continues with image cleanup", async () => {
  const abandonedImage = `${sessionImageName("abandoned-session")}:latest`;
  const fixture = await pruningFixture({
    containers: [{ id: abandonedContainer, sessionId: "abandoned-session" }],
    images: [abandonedImage],
  });
  await sessionDirectory(fixture.agentDir, "abandoned-session");
  const listings = podman.getMockImplementation()!;
  podman.mockImplementation(async (args: string[]) => {
    if (args[0] === "rm") {
      throw new Error("Container removal failed");
    }
    return listings(args);
  });
  await fixture.prune();
  expect(fixture.report).toHaveBeenCalledWith(expect.stringContaining("Container removal failed"));
  expect(podman).toHaveBeenCalledWith(["rmi", abandonedImage]);
});
