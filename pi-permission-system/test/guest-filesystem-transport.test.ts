import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PreparedEnvironment } from "../src/sandbox/driver.ts";
import { GuestFilesystem } from "../src/sandbox/filesystem.ts";
import {
  GuestFilesystemTransport,
  type GuestChannelStarter,
  type GuestFilesystemTiming,
} from "../src/sandbox/guest-filesystem-transport.ts";
import { JsonLineChannel } from "../src/sandbox/json-line-channel.ts";

const ports = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  ports.spawn.mockImplementation(actual.spawn);
  return { ...actual, spawn: ports.spawn };
});

const directories: string[] = [];
const transports: GuestFilesystemTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function environmentFor(workspace: string, container = "container-g1"): PreparedEnvironment {
  return { container, image: "image", user: "root", workspace, configuration: {} };
}

const localPythonServer: GuestChannelStarter = (environment, serverScript) =>
  new JsonLineChannel({
    args: ["-u", "-c", serverScript, "--serve"],
    env: { ...process.env, PODMAN_PROGRAM_REPLACED_BY_TEST: environment.container },
    label: "Guest filesystem transport",
    maxMessageBytes: 24 * 1024 * 1024,
  });

async function localTransportFixture() {
  const workspace = await mkdtemp(join(tmpdir(), "guest-transport-"));
  directories.push(workspace);
  const timings: GuestFilesystemTiming[] = [];
  ports.spawn.mockClear();
  const actualSpawn = ports.spawn.getMockImplementation()!;
  ports.spawn.mockImplementation((_command: string, args: string[], options: unknown) =>
    actualSpawn("python3", args, options),
  );
  const transport = new GuestFilesystemTransport({
    start: localPythonServer,
    timing: (timing) => timings.push(timing),
  });
  transports.push(transport);
  const filesystem = new GuestFilesystem(
    () => environmentFor(workspace),
    async () => {
      throw new Error("Per-call guest execution must not be used with a transport");
    },
    { transport },
  );
  return { workspace, transport, filesystem, timings };
}

it("serves many filesystem operations through one long-lived guest process", async () => {
  const fixture = await localTransportFixture();
  await fixture.filesystem.mkdir("nested");
  await fixture.filesystem.write("nested/file.ts", "export const value = 1;\n");
  expect((await fixture.filesystem.read("nested/file.ts")).toString()).toBe(
    "export const value = 1;\n",
  );
  expect(await fixture.filesystem.list("nested")).toEqual(["file.ts"]);
  expect(await fixture.filesystem.canonical("nested/../nested/file.ts")).toBe(
    join(fixture.workspace, "nested", "file.ts"),
  );
  expect(await readFile(join(fixture.workspace, "nested", "file.ts"), "utf8")).toBe(
    "export const value = 1;\n",
  );
  expect(ports.spawn).toHaveBeenCalledOnce();
  expect(fixture.timings.map((timing) => [timing.operation, timing.outcome])).toEqual([
    ["mkdir", "ok"],
    ["write", "ok"],
    ["read", "ok"],
    ["list", "ok"],
    ["canonical", "ok"],
  ]);
});

it("reports a failing operation without losing the guest process", async () => {
  const fixture = await localTransportFixture();
  await expect(fixture.filesystem.read("missing.ts")).rejects.toThrow(
    /Guest read failed for missing\.ts: .*FileNotFoundError/,
  );
  await fixture.filesystem.write("present.ts", "ok");
  expect((await fixture.filesystem.read("present.ts")).toString()).toBe("ok");
  expect(ports.spawn).toHaveBeenCalledOnce();
  expect(fixture.timings[0]).toMatchObject({ operation: "read", outcome: "error" });
});

function silentChannelFixture() {
  const channels: Array<{ send: ReturnType<typeof vi.fn>; abandon: ReturnType<typeof vi.fn> }> = [];
  const start: GuestChannelStarter = () => {
    let failed: Error | undefined;
    const pending = new Map<number, (error: Error) => void>();
    let nextId = 0;
    const channel = {
      get failed() {
        return failed;
      },
      send: vi.fn(() => {
        const id = ++nextId;
        const response = new Promise((_resolve, reject) => pending.set(id, reject));
        return { id, response };
      }),
      abandon: vi.fn((id: number, error: Error) => pending.get(id)?.(error)),
      fail: (error: Error) => {
        failed = error;
      },
      close: vi.fn(async () => {}),
    };
    channels.push(channel);
    return channel as unknown as JsonLineChannel;
  };
  return { start, channels };
}

it("times out one slow request without stopping the guest process", async () => {
  vi.useFakeTimers();
  try {
    const fixture = silentChannelFixture();
    const timings: GuestFilesystemTiming[] = [];
    const transport = new GuestFilesystemTransport({
      start: fixture.start,
      timing: (timing) => timings.push(timing),
    });
    const slow = transport.request(
      environmentFor("/w"),
      { operation: "read", path: "big" },
      undefined,
      1_000,
    );
    const rejected = expect(slow).rejects.toThrow("Guest read timed out after 1000ms");
    await vi.waitFor(() => expect(fixture.channels[0]?.send).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(fixture.channels).toHaveLength(1);
    expect(fixture.channels[0]!.abandon).toHaveBeenCalledOnce();
    expect(timings).toEqual([
      { operation: "read", milliseconds: expect.any(Number), outcome: "timeout" },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("starts a new guest process after the previous one failed or the container changed", async () => {
  const fixture = silentChannelFixture();
  const transport = new GuestFilesystemTransport({ start: fixture.start, requestTimeoutMs: 5 });
  await expect(
    transport.request(environmentFor("/w"), { operation: "stat", path: "." }),
  ).rejects.toThrow("timed out");
  expect(fixture.channels).toHaveLength(1);
  (fixture.channels[0] as unknown as JsonLineChannel).fail(new Error("conmon exited"));
  await expect(
    transport.request(environmentFor("/w"), { operation: "stat", path: "." }),
  ).rejects.toThrow("timed out");
  expect(fixture.channels).toHaveLength(2);
  await expect(
    transport.request(environmentFor("/w", "container-g2"), { operation: "stat", path: "." }),
  ).rejects.toThrow("timed out");
  expect(fixture.channels).toHaveLength(3);
});

it("rejects a cancelled request immediately while the guest process keeps serving", async () => {
  const fixture = silentChannelFixture();
  const transport = new GuestFilesystemTransport({ start: fixture.start });
  const cancellation = new AbortController();
  const reason = new Error("Operator cancelled");
  const pending = transport.request(
    environmentFor("/w"),
    { operation: "glob", path: "." },
    cancellation.signal,
  );
  await vi.waitFor(() => expect(fixture.channels[0]?.send).toHaveBeenCalledOnce());
  cancellation.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(fixture.channels[0]!.abandon).toHaveBeenCalledWith(1, reason);
  expect((fixture.channels[0] as unknown as JsonLineChannel).failed).toBeUndefined();
});
