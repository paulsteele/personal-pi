import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SandboxSession } from "../src/sandbox/session.ts";
import type { ResolvedDefinition } from "../src/sandbox/definition.ts";
import { readPrivateText } from "../src/sandbox/storage.ts";

const ports = vi.hoisted(() => ({ create: vi.fn(), podman: vi.fn(), forward: vi.fn(), execute: vi.fn() }));
vi.mock("../src/sandbox/process.ts", async (original) => ({
  ...(await original<typeof import("../src/sandbox/process.ts")>()),
  runGuestProcess: ports.execute,
}));
vi.mock("../src/sandbox/driver.ts", () => ({
  createDevcontainer: ports.create,
  podmanOutput: ports.podman,
}));
vi.mock("../src/sandbox/ports.ts", () => ({
  devcontainerPorts: () => [],
  startLoopbackForwarders: ports.forward,
}));
const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sandbox-definition-rebuild-")));
  directories.push(directory);
  const root = join(directory, "workspace");
  const agentDir = join(directory, "agent");
  await mkdir(root);
  const resolved: ResolvedDefinition = {
    path: join(directory, "devcontainer.json"),
    sourceText: '{"image":"node"}',
    revision: "original",
    definition: { image: "node" },
    tier: "global",
    startupDirectory: root,
    project: { id: "a".repeat(64), kind: "projects", root },
  };
  const confirm = vi.fn(async () => true);
  const session = new SandboxSession({
    agentDir,
    sessionId: "session",
    resolved,
    hostEnvironment: [],
    confirm,
  });
  const oldEnvironment = {
    container: "original-container",
    image: "node",
    user: "root",
    workspace: root,
    configuration: {},
  };
  const newEnvironment = { ...oldEnvironment, container: "rebuilt-container", image: "tool-image" };
  ports.create.mockResolvedValueOnce(oldEnvironment).mockResolvedValue(newEnvironment);
  ports.podman.mockResolvedValue("");
  ports.forward.mockResolvedValue({ close: vi.fn(async () => {}) });
  await session.start();
  const replacement: ResolvedDefinition = {
    ...resolved,
    revision: "tools",
    definition: { build: { dockerfile: "Containerfile.quality" } },
  };
  return { session, replacement, oldEnvironment, newEnvironment, root, confirm };
}

it("releases the session owner lock even when a retirement listener fails", async () => {
  const f = await fixture();
  const failRetirementListener = async () => {
    throw new Error("Reviewer removal failed");
  };
  f.session.beforeContainerRetirement(failRetirementListener);
  await expect(f.session.close()).rejects.toThrow("Sandbox session cleanup failed");
  expect(await readPrivateText(join(f.session.directory, "owner.lock"))).toBeUndefined();
  expect(ports.podman).toHaveBeenCalledWith(["stop", "--time=0", "original-container"]);
});

it("cancels an ordinary guest command before rebuilding the container generation", async () => {
  const f = await fixture();
  ports.execute.mockImplementation(async (options: { signal: AbortSignal }) => {
    await new Promise<void>((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  });
  const running = f.session.execute({ command: ["sleep", "30"] });
  const cancelled = expect(running).rejects.toThrow();
  try {
    await f.session.rebuildFromDefinition(f.replacement);
    await cancelled;
    expect(ports.execute.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(f.session.generation).toBe(2);
  } finally {
    await f.session.close();
  }
});

it("restores readiness after cancelling replacement while a guest command terminates", async () => {
  const f = await fixture();
  const { promise: terminationWait, resolve: finishTermination } = Promise.withResolvers<void>();
  const terminating = vi.fn();
  ports.execute.mockImplementation(async (options: { signal: AbortSignal }) => {
    await new Promise<void>((resolve) => {
      options.signal.addEventListener("abort", () => { terminating(); resolve(); }, { once: true });
    });
    await terminationWait;
    options.signal.throwIfAborted();
  });
  const running = f.session.execute({ command: ["sleep", "30"] });
  const abortedCommand = expect(running).rejects.toThrow();
  const cancellation = new AbortController();
  const replacing = f.session.rebuildFromDefinition(f.replacement, cancellation.signal);
  const rejectedReplacement = expect(replacing).rejects.toThrow("Cancelled replacement");
  try {
    await vi.waitFor(() => expect(terminating).toHaveBeenCalledOnce());
    cancellation.abort(new Error("Cancelled replacement"));
    finishTermination();
    await abortedCommand;
    await rejectedReplacement;
    expect(f.session.environment.container).toBe("original-container");
    expect(f.session.generation).toBe(1);
    expect(ports.create).toHaveBeenCalledOnce();
  } finally {
    finishTermination();
    await f.session.close();
  }
});

it("joins a failed replacement before releasing ownership and never restarts it during shutdown", async () => {
  const f = await fixture();
  const { promise: buildWait, reject: failBuild } = Promise.withResolvers<never>();
  ports.create.mockImplementationOnce(() => buildWait);
  const rebuilding = f.session.rebuildFromDefinition(f.replacement);
  const failedRebuild = expect(rebuilding).rejects.toThrow("Build interrupted");
  await vi.waitFor(() => expect(ports.create).toHaveBeenCalledTimes(2));
  const closing = f.session.close();
  expect(await readPrivateText(join(f.session.directory, "owner.lock"))).toBeDefined();
  failBuild(new Error("Build interrupted"));
  await failedRebuild;
  await closing;
  expect(ports.podman).not.toHaveBeenCalledWith(["start", "original-container"]);
  expect(await readPrivateText(join(f.session.directory, "owner.lock"))).toBeUndefined();
  expect(ports.forward).toHaveBeenCalledOnce();
});

it("bounds a stalled retirement listener and still releases the owner lock", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const { promise: listenerWait, resolve: finishListener } = Promise.withResolvers<void>();
  f.session.beforeContainerRetirement(() => listenerWait);
  const closing = f.session.close();
  const rejected = expect(closing).rejects.toThrow("Sandbox session cleanup failed");
  try {
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(await readPrivateText(join(f.session.directory, "owner.lock"))).toBeUndefined();
    expect(ports.podman).toHaveBeenCalledWith(["stop", "--time=0", "original-container"]);
  } finally {
    finishListener();
    vi.useRealTimers();
  }
});

it("saves the rebuilt definition revision and reuses the tool image when the session resumes", async () => {
  const f = await fixture();
  const mounts = [...f.session.mounts];
  const retire = vi.fn(async () => {});
  const recordPath = join(f.session.directory, "session.json");
  ports.podman.mockImplementation(async (args: string[]) => {
    if (args[0] === "rm") {
      expect(JSON.parse((await readPrivateText(recordPath))!.text)).toMatchObject({
        definitionRevision: "tools",
        generation: 2,
        environment: { container: "rebuilt-container" },
      });
    }
    return "";
  });
  f.session.beforeContainerRetirement(retire);
  await f.session.rebuildFromDefinition(f.replacement, new AbortController().signal);
  expect(retire).toHaveBeenCalledTimes(1);
  expect(f.session.options.resolved).toBe(f.replacement);
  expect(f.session.mounts).toEqual(mounts);
  expect(f.session.generation).toBe(2);
  expect(f.session.environment.container).toBe("rebuilt-container");
  expect(ports.podman).toHaveBeenCalledWith(["rm", "original-container"]);
  expect(
    JSON.parse((await readPrivateText(join(f.session.directory, "session.json")))!.text),
  ).toMatchObject({ definitionRevision: "tools", generation: 2 });
  expect(f.confirm).not.toHaveBeenCalled();
  expect(
    await readPrivateText(join(f.session.directory, "definition-approval.json")),
  ).toBeUndefined();
  await f.session.close();
  const resumed = new SandboxSession({ ...f.session.options });
  try {
    await resumed.start();
    expect(ports.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resolved: f.replacement,
        checkpointImage: "tool-image",
        previousContainer: "rebuilt-container",
        generation: 2,
      }),
    );
    expect(resumed.generation).toBe(2);
    expect(f.confirm).not.toHaveBeenCalled();
  } finally {
    await resumed.close();
  }
});

it("keeps the original definition and restarts its container when the image rebuild fails", async () => {
  const f = await fixture();
  ports.create.mockRejectedValueOnce(new Error("Build failed"));
  try {
    await expect(f.session.rebuildFromDefinition(f.replacement)).rejects.toThrow("Build failed");
    expect(f.session.options.resolved.revision).toBe("original");
    expect(f.session.environment.container).toBe("original-container");
    expect(f.session.generation).toBe(1);
    expect(ports.podman).toHaveBeenCalledWith(["start", "original-container"]);
    expect(ports.podman.mock.calls.filter(([args]) => args[0] === "rm")).toEqual([]);
    expect(
      JSON.parse((await readPrivateText(join(f.session.directory, "session.json")))!.text)
        .definitionRevision,
    ).toBe("original");
  } finally {
    await f.session.close();
  }
});

it("keeps the previous rebuild container when starting replacement forwarders fails", async () => {
  const f = await fixture();
  ports.forward.mockRejectedValueOnce(new Error("Forwarding failed"));
  try {
    await expect(f.session.rebuildFromDefinition(f.replacement)).rejects.toThrow(
      "Forwarding failed",
    );
    expect(ports.podman).toHaveBeenCalledWith(["stop", "rebuilt-container"]);
    expect(ports.podman).toHaveBeenCalledWith(["start", "original-container"]);
    expect(ports.podman.mock.calls.filter(([args]) => args[0] === "rm")).toEqual([]);
    expect(f.session.generation).toBe(1);
  } finally {
    await f.session.close();
  }
});

it("does not roll back a successful rebuild when superseded-container removal fails", async () => {
  const f = await fixture();
  ports.podman.mockImplementation(async (args: string[]) => {
    if (args[0] === "rm") {
      throw new Error("Removal failed");
    }
    return "";
  });
  try {
    await f.session.rebuildFromDefinition(f.replacement);
    expect(ports.podman).toHaveBeenCalledWith(["rm", "original-container"]);
    expect(ports.podman).not.toHaveBeenCalledWith(["start", "original-container"]);
    expect(f.session.generation).toBe(2);
    expect(f.session.environment.container).toBe("rebuilt-container");
  } finally {
    await f.session.close();
  }
});

it("rejects topology changes before stopping the current container", async () => {
  const f = await fixture();
  ports.podman.mockClear();
  try {
    await expect(
      f.session.rebuildFromDefinition({
        ...f.replacement,
        definition: {
          ...f.replacement.definition,
          mounts: ["type=bind,source=/extra,target=/extra"],
        },
      }),
    ).rejects.toThrow("cannot change sandbox topology");
    expect(ports.podman).not.toHaveBeenCalled();
    expect(f.session.generation).toBe(1);
  } finally {
    await f.session.close();
  }
});
