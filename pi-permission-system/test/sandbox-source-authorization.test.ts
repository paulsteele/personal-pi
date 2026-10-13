import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxService } from "../src/sandbox/service.ts";
import { createMountGrant } from "../src/sandbox/mounts.ts";
import { GuestFilesystem } from "../src/sandbox/filesystem.ts";
import { reviewSandboxAction } from "../src/sandbox/gate.ts";
import { parseSandboxSettings, saveSandboxSettings } from "../src/sandbox/settings.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function sandboxAuthorizationFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sandbox-source-")));
  directories.push(directory);
  const root = join(directory, "project");
  const agentDir = join(directory, "agent");
  const privateStorage = join(agentDir, "extensions/pi-permission-system");
  await mkdir(root);
  await mkdir(privateStorage, { recursive: true });
  const grant = await createMountGrant({
    path: root,
    destination: "/workspace",
    access: "rw",
    privateStorage,
  });
  const canonicalPaths = vi.fn(async (paths: string[], _signal?: AbortSignal) => [...paths]);
  const canonical = vi.fn(async (path: string) => path);
  const session = {
    options: { sessionId: "session" },
    revision: "authority",
    environment: {
      container: "container",
      workspace: "/workspace",
      configuration: {},
      remoteEnvironment: { HOME: "/home/developer" },
    },
    mounts: [grant],
    filesystem: { canonicalPaths, canonical },
  };
  const service = createSandboxService(session as never);
  return { root, agentDir, service, session, canonicalPaths, canonical };
}

it("checks several source paths in one guest probe without a second canonicalization", async () => {
  const sandbox = await sandboxAuthorizationFixture();
  await writeFile(join(sandbox.root, "a.ts"), "a");
  await writeFile(join(sandbox.root, "b.ts"), "b");
  const signal = new AbortController().signal;
  const paths = await sandbox.service.authorizeHostSources(
    [join(sandbox.root, "a.ts"), join(sandbox.root, "b.ts")],
    signal,
  );
  expect(paths).toEqual(["/workspace/a.ts", "/workspace/b.ts"]);
  expect(sandbox.canonicalPaths).toHaveBeenCalledExactlyOnceWith(paths, signal);
  expect(sandbox.canonical).not.toHaveBeenCalled();
});

it("serializes concurrent reviewer probes without sharing or caching their authorizations", async () => {
  const sandbox = await sandboxAuthorizationFixture();
  const signals = Array.from({ length: 4 }, () => new AbortController().signal);
  const releases: Array<() => void> = [];
  let active = 0;
  let peakActive = 0;
  sandbox.canonicalPaths.mockImplementation(async (paths) => {
    active++;
    peakActive = Math.max(peakActive, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return [...paths];
  });
  const checks = signals.map((signal) =>
    sandbox.service.authorizeHostSources([join(sandbox.root, "a.ts")], signal),
  );
  for (let checkIndex = 0; checkIndex < checks.length; checkIndex++) {
    await vi.waitFor(() => expect(sandbox.canonicalPaths).toHaveBeenCalledTimes(checkIndex + 1));
    expect(active).toBe(1);
    releases[checkIndex]!();
  }
  await Promise.all(checks);
  expect(peakActive).toBe(1);
  expect(new Set(sandbox.canonicalPaths.mock.calls.map((call) => call[1]))).toEqual(
    new Set(signals),
  );
});

it("releases a failed reviewer probe and skips cancelled queued probes", async () => {
  const sandbox = await sandboxAuthorizationFixture();
  let release!: () => void;
  sandbox.canonicalPaths.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    throw new Error("Podman exec failed");
  });
  const first = sandbox.service.authorizeHostSource(join(sandbox.root, "a.ts"));
  const failed = expect(first).rejects.toThrow("Podman exec failed");
  await vi.waitFor(() => expect(sandbox.canonicalPaths).toHaveBeenCalledOnce());
  const cancellation = new AbortController();
  const cancelled = sandbox.service.authorizeHostSource(
    join(sandbox.root, "b.ts"),
    cancellation.signal,
  );
  const rejected = expect(cancelled).rejects.toThrow();
  const next = sandbox.service.authorizeHostSource(join(sandbox.root, "c.ts"));
  cancellation.abort();
  release();
  await failed;
  await rejected;
  await next;
  expect(sandbox.canonicalPaths.mock.calls.map((call) => call[0])).toEqual([
    ["/workspace/a.ts"],
    ["/workspace/c.ts"],
  ]);
});

it("authorizes a deleted historical source through the canonical parent of its approved bind", async () => {
  const sandbox = await sandboxAuthorizationFixture();
  await mkdir(join(sandbox.root, "deleted"));
  await expect(
    sandbox.service.authorizeHostSource(join(sandbox.root, "deleted/old.ts")),
  ).resolves.toBeUndefined();
  expect(sandbox.canonicalPaths).toHaveBeenCalledWith(["/workspace/deleted/old.ts"], undefined);
});

it("rejects source paths outside approved mappings before probing the guest", async () => {
  const sandbox = await sandboxAuthorizationFixture();
  await expect(sandbox.service.authorizeHostSource(tmpdir())).rejects.toThrow(
    "outside approved sandbox mounts",
  );
  expect(sandbox.canonicalPaths).not.toHaveBeenCalled();
});

it("rejects host symlinks that redirect missing historical sources outside the bind", async () => {
  const sandbox = await sandboxAuthorizationFixture();
  await symlink(tmpdir(), join(sandbox.root, "outside"));
  await expect(
    sandbox.service.authorizeHostSource(join(sandbox.root, "outside/nonexistent.ts")),
  ).rejects.toThrow("outside approved sandbox mounts");
  expect(sandbox.canonicalPaths).not.toHaveBeenCalled();
});

it("rejects a guest symlink whose destination disagrees with the host source", async () => {
  const sandbox = await sandboxAuthorizationFixture();
  await writeFile(join(sandbox.root, "a.ts"), "a");
  sandbox.canonicalPaths.mockResolvedValue(["/workspace/different.ts"]);
  await expect(sandbox.service.authorizeHostSource(join(sandbox.root, "a.ts"))).rejects.toThrow(
    "does not resolve",
  );
});

it("passes cancellation through the source authorization probe", async () => {
  const sandbox = await sandboxAuthorizationFixture();
  sandbox.canonicalPaths.mockImplementation(async (_paths, signal?: AbortSignal) => {
    await new Promise<void>((resolve) =>
      signal!.addEventListener("abort", () => resolve(), { once: true }),
    );
    signal!.throwIfAborted();
    return [];
  });
  const controller = new AbortController();
  const pending = sandbox.service.authorizeHostSource(
    join(sandbox.root, "a.ts"),
    controller.signal,
  );
  await vi.waitFor(() => expect(sandbox.canonicalPaths).toHaveBeenCalled());
  controller.abort();
  await expect(pending).rejects.toThrow();
});

it("a prevalidated canonical path still checks live explicit denies without another guest process", async () => {
  const sandbox = await sandboxAuthorizationFixture();
  await saveSandboxSettings(
    sandbox.agentDir,
    parseSandboxSettings({ permission: { path: { "/workspace/a.ts": "deny" } } }),
    undefined,
  );
  await expect(
    reviewSandboxAction({
      session: sandbox.session as never,
      canonicalGuestPath: "/workspace/a.ts",
      agentDir: sandbox.agentDir,
      toolName: "read",
      input: { path: "/workspace/a.ts" },
      ctx: {} as never,
    }),
  ).rejects.toThrow("Path denied by explicit policy");
  expect(sandbox.canonical).not.toHaveBeenCalled();
});

it("passes guest HOME to batched entry probes and preserves explicit existence results", async () => {
  const execute = vi.fn(async (_options: { input: Buffer }) => ({
    code: 0,
    output: Buffer.from("[true,false]"),
    stderr: "",
  }));
  const remoteEnvironment = { HOME: "/home/developer" };
  const filesystem = new GuestFilesystem(
    () =>
      ({
        container: "container",
        user: "developer",
        workspace: "/workspace",
        remoteEnvironment,
      }) as never,
    execute as never,
  );
  const signal = new AbortController().signal;
  expect(await filesystem.entriesExist(["secret", "missing"], signal)).toEqual([true, false]);
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ environment: remoteEnvironment, timeoutMs: 10_000, signal }),
  );
  expect(JSON.parse(execute.mock.calls[0]![0].input.toString())).toMatchObject({
    operation: "entries_exist",
    paths: ["secret", "missing"],
  });
});

it("guest canonical batch requests have a bounded probe timeout and preserve the call signal", async () => {
  const execute = vi.fn(async (_options: { input: Buffer }) => ({
    code: 0,
    output: Buffer.from('["/workspace/a.ts","/workspace/b.ts"]'),
    stderr: "",
  }));
  const filesystem = new GuestFilesystem(
    () => ({ container: "container", user: "user", workspace: "/workspace" }) as never,
    execute as never,
  );
  const signal = new AbortController().signal;
  const paths = ["a.ts", "b.ts"];
  expect(await filesystem.canonicalPaths(paths, signal)).toEqual([
    "/workspace/a.ts",
    "/workspace/b.ts",
  ]);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 10_000, signal }));
  expect(JSON.parse(execute.mock.calls[0]![0].input.toString())).toMatchObject({
    operation: "canonical_paths",
    paths,
  });
});
