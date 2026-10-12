import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SandboxSession } from "../src/sandbox/session.ts";
import type { ResolvedDefinition } from "../src/sandbox/definition.ts";
import { readPrivateText, sha256Hex } from "../src/sandbox/storage.ts";
import { inactiveSessionRetentionMs } from "../src/sandbox/prune.ts";
import type { SandboxStartupDisplay, SandboxStartupProgress } from "../src/sandbox/startup-ui.ts";

const ports = vi.hoisted(() => ({ create: vi.fn(), podman: vi.fn(), forward: vi.fn() }));
vi.mock("../src/sandbox/driver.ts", () => ({
  createDevcontainer: ports.create,
  podmanOutput: ports.podman,
}));
vi.mock("../src/sandbox/ports.ts", () => ({
  devcontainerPorts: (forwardedPorts: number[]) => forwardedPorts,
  startLoopbackForwarders: ports.forward,
}));

const directories: string[] = [];
const sessions: SandboxSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close();
  }
  vi.resetAllMocks();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function resumeFixture(startup?: SandboxStartupDisplay) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sandbox-resume-")));
  directories.push(directory);
  const root = join(directory, "workspace");
  const source = join(directory, "config.json");
  await mkdir(root);
  await writeFile(source, '{"model":"original"}');
  const resolved: ResolvedDefinition = {
    path: join(directory, "devcontainer.json"),
    sourceText: '{"image":"node"}',
    revision: "original",
    definition: { image: "node" },
    tier: "global",
    startupDirectory: root,
    project: { id: "a".repeat(64), kind: "projects", root },
  };
  const confirm = vi.fn(async (_preview: string, _signal?: AbortSignal) => true);
  const options = {
    agentDir: join(directory, "agent"),
    sessionId: "session",
    resolved,
    hostEnvironment: [],
    confirm,
    startup,
  };
  ports.create.mockImplementation(async ({ generation }) => ({
    container: `container-g${generation}`,
    image: "node",
    user: "root",
    workspace: root,
    configuration: {},
  }));
  ports.podman.mockImplementation(async (args: string[]) =>
    args[0] === "commit" ? "checkpoint-image\n" : "",
  );
  ports.forward.mockResolvedValue({ close: vi.fn(async () => {}) });
  const original = new SandboxSession(options);
  sessions.push(original);
  await original.start();
  await original.requestMount(source, "ro", "/config.json", "Read configuration");
  const approvedMounts = [...original.mounts];
  await original.close();
  const recordPath = join(original.directory, "session.json");
  const stored = (await readPrivateText(recordPath))!;
  const resumed = new SandboxSession({ ...options });
  sessions.push(resumed);
  const replaceFile = async () => {
    const temporary = join(directory, "replacement.json");
    await writeFile(temporary, '{"model":"replacement"}');
    await rename(temporary, source);
  };
  ports.create.mockClear();
  ports.podman.mockClear();
  ports.forward.mockClear();
  confirm.mockClear();
  return { resumed, source, approvedMounts, confirm, replaceFile, recordPath, stored };
}

it("does not save denied port authority or reuse it on the next startup", async () => {
  const fixture = await resumeFixture();
  const options = {
    ...fixture.resumed.options, sessionId: "port-session",
    resolved: {
      ...fixture.resumed.options.resolved,
      definition: { image: "node", forwardPorts: [3000] },
    },
  };
  const deniedStartup = new SandboxSession(options);
  sessions.push(deniedStartup);
  fixture.confirm.mockResolvedValue(false);
  await expect(deniedStartup.start()).rejects.toThrow("port forwarding was not approved");
  await deniedStartup.close();
  expect(await readPrivateText(join(deniedStartup.directory, "session.json"))).toBeUndefined();
  expect(fixture.confirm).toHaveBeenCalledWith(expect.stringContaining("3000"), expect.any(AbortSignal));
  fixture.confirm.mockClear();
  fixture.confirm.mockResolvedValue(true);
  const approvedStartup = new SandboxSession(options);
  sessions.push(approvedStartup);
  await approvedStartup.start();
  expect(fixture.confirm).toHaveBeenCalledWith(expect.stringContaining("3000"), expect.any(AbortSignal));
  expect(JSON.parse((await readPrivateText(join(approvedStartup.directory, "session.json")))!.text).approvedPorts).toEqual([3000]);
});

it.each([
  { tier: "global", definition: { image: "node" } },
  { tier: "project", definition: { image: "node" } },
  { tier: "local", definition: { image: "node" } },
  { tier: "global", definition: { build: { dockerfile: "Containerfile.quality" } } },
] as const)(
  "starts a new session with a $tier definition without approval",
  async ({ tier, definition }) => {
    const fixture = await resumeFixture();
    fixture.confirm.mockResolvedValue(false);
    const fresh = new SandboxSession({
      ...fixture.resumed.options,
      sessionId: "new-session",
      resolved: {
        ...fixture.resumed.options.resolved,
        tier,
        definition,
        revision: "changed-definition",
      },
    });
    sessions.push(fresh);
    expect(
      await readPrivateText(join(fresh.directory, "definition-approval.json")),
    ).toBeUndefined();
    await fresh.start();
    expect(fixture.confirm).not.toHaveBeenCalled();
    expect(ports.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ resolved: fresh.options.resolved, sessionId: "new-session" }),
    );
    expect(fresh.mounts).toHaveLength(1);
    expect(
      await readPrivateText(join(fresh.directory, "definition-approval.json")),
    ).toBeUndefined();
  },
);

it("still requires approval for a host bind declared in the definition", async () => {
  const fixture = await resumeFixture();
  fixture.confirm.mockResolvedValue(false);
  const fresh = new SandboxSession({
    ...fixture.resumed.options,
    sessionId: "new-session-with-bind",
    resolved: {
      ...fixture.resumed.options.resolved,
      definition: {
        image: "node",
        mounts: [`type=bind,source=${fixture.source},target=/declared-config.json`],
      },
    },
  });
  sessions.push(fresh);
  await expect(fresh.start()).rejects.toThrow("Declared host mount was not approved");
  expect(fixture.confirm).toHaveBeenCalledTimes(1);
  expect(fixture.confirm.mock.calls[0][0]).toContain("Approve declared host bind");
  expect(fixture.confirm.mock.calls[0][0]).toContain(fixture.source);
  expect(ports.create).not.toHaveBeenCalled();
});

it("reuses the same stopped container and generation when approved sources are unchanged", async () => {
  const fixture = await resumeFixture();
  await fixture.resumed.start();
  expect(fixture.confirm).not.toHaveBeenCalled();
  expect(ports.podman).not.toHaveBeenCalled();
  expect(ports.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      mounts: fixture.approvedMounts,
      previousContainer: "container-g2",
      checkpointImage: "node",
      generation: 2,
    }),
  );
  expect(fixture.resumed.generation).toBe(2);
});

it("reapproves an atomically saved config and recreates the bind from a container checkpoint", async () => {
  const fixture = await resumeFixture();
  await fixture.replaceFile();
  await fixture.resumed.start();
  expect(fixture.confirm).toHaveBeenCalledTimes(1);
  expect(fixture.confirm.mock.calls[0][0]).toContain(`Source: ${fixture.source}`);
  expect(fixture.confirm.mock.calls[0][0]).toContain("Access: ro");
  expect(ports.podman).toHaveBeenCalledWith(["stop", "container-g2"], expect.any(AbortSignal));
  expect(ports.podman).toHaveBeenCalledWith(
    ["commit", "--include-volumes=false", "container-g2"],
    expect.any(AbortSignal),
  );
  expect(ports.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      directory: join(fixture.resumed.directory, "generation-3"),
      previousContainer: undefined,
      checkpointImage: "checkpoint-image",
      generation: 3,
    }),
  );
  expect(fixture.resumed.mounts[0]).toEqual(fixture.approvedMounts[0]);
  expect(fixture.resumed.mounts[1]).toEqual({
    ...fixture.approvedMounts[1],
    identity: expect.any(String),
  });
  expect(fixture.resumed.mounts[1].identity).not.toBe(fixture.approvedMounts[1].identity);
  expect(fixture.resumed.environment.container).toBe("container-g3");
  expect(ports.podman).toHaveBeenCalledWith(["rm", "container-g2"]);
  expect(JSON.parse((await readPrivateText(fixture.recordPath))!.text)).toMatchObject({
    generation: 3,
    mounts: fixture.resumed.mounts,
  });

  await fixture.resumed.close();
  const nextReload = new SandboxSession({ ...fixture.resumed.options });
  sessions.push(nextReload);
  fixture.confirm.mockClear();
  ports.create.mockClear();
  await nextReload.start();
  expect(fixture.confirm).not.toHaveBeenCalled();
  expect(ports.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ previousContainer: "container-g3", generation: 3 }),
  );
});

it("does not start a container or overwrite authority when replacement approval is denied", async () => {
  const fixture = await resumeFixture();
  await fixture.replaceFile();
  fixture.confirm.mockResolvedValue(false);
  await expect(fixture.resumed.start()).rejects.toThrow("Replacement host mount was not approved");
  expect(ports.create).not.toHaveBeenCalled();
  expect(ports.podman).not.toHaveBeenCalled();
  expect(await readPrivateText(fixture.recordPath)).toEqual(fixture.stored);
});

it("reports initial startup, mount recreation, resume, and definition rebuild to the startup display", async () => {
  const progress: SandboxStartupProgress = { stage: vi.fn(), output: vi.fn() };
  const startup: SandboxStartupDisplay = {
    run: async (_title, operation) => operation(progress),
  };
  const run = vi.spyOn(startup, "run");
  const fixture = await resumeFixture(startup);
  expect(run.mock.calls.map(([title]) => title)).toEqual([
    "Starting devcontainer",
    "Updating devcontainer mounts",
  ]);
  run.mockClear();
  ports.create.mockImplementation(async ({ progress: report }) => {
    report("Starting lifecycle hooks\n");
    return {
      container: "resumed-container",
      image: "node",
      user: "root",
      workspace: fixture.resumed.options.resolved.startupDirectory,
      configuration: {},
    };
  });
  await fixture.resumed.start();
  expect(run.mock.calls.map(([title]) => title)).toEqual(["Starting devcontainer"]);
  expect(progress.output).toHaveBeenCalledWith("Starting lifecycle hooks\n");
  run.mockClear();
  await fixture.resumed.rebuildFromDefinition(fixture.resumed.options.resolved);
  expect(run.mock.calls.map(([title]) => title)).toEqual(["Rebuilding devcontainer"]);
  expect(progress.stage).toHaveBeenCalledWith("Stopping devcontainer language servers…");
  expect(progress.stage).toHaveBeenCalledWith("Waiting for active guest processes…");
  expect(progress.stage).toHaveBeenCalledWith("Stopping the previous devcontainer…");
  expect(progress.stage).toHaveBeenCalledWith("Starting rebuilt devcontainer port forwarders…");
  expect(progress.stage).toHaveBeenCalledWith("Saving rebuilt devcontainer session…");
  expect(progress.stage).toHaveBeenCalledWith("Removing superseded devcontainer…");
  expect(progress.stage).toHaveBeenLastCalledWith("Devcontainer rebuild complete.");
});

it("retains stored grants and restarts the prior container if replacement creation fails", async () => {
  const fixture = await resumeFixture();
  await fixture.replaceFile();
  ports.create.mockRejectedValueOnce(new Error("Recreation failed"));
  await expect(fixture.resumed.start()).rejects.toThrow("Recreation failed");
  expect(ports.podman).toHaveBeenCalledWith(["start", "container-g2"]);
  expect(ports.podman.mock.calls.filter(([args]) => args[0] === "rm")).toEqual([]);
  expect(await readPrivateText(fixture.recordPath)).toEqual(fixture.stored);
});

it("removes a superseded resume container only after forwarders start and the record is saved", async () => {
  const fixture = await resumeFixture();
  await fixture.replaceFile();
  ports.forward.mockImplementationOnce(async () => {
    expect(ports.podman.mock.calls.filter(([args]) => args[0] === "rm")).toEqual([]);
    return { close: vi.fn(async () => {}) };
  });
  ports.podman.mockImplementation(async (args: string[]) => {
    if (args[0] === "rm") {
      expect(JSON.parse((await readPrivateText(fixture.recordPath))!.text)).toMatchObject({
        generation: 3,
        environment: { container: "container-g3" },
      });
    }
    return args[0] === "commit" ? "checkpoint-image\n" : "";
  });
  await fixture.resumed.start();
  expect(ports.podman).toHaveBeenCalledWith(["rm", "container-g2"]);
});

it("retains the prior generation if replacement forwarders cannot start on resume", async () => {
  const fixture = await resumeFixture();
  await fixture.replaceFile();
  ports.forward.mockRejectedValueOnce(new Error("Forwarding failed"));
  await expect(fixture.resumed.start()).rejects.toThrow("Forwarding failed");
  expect(ports.podman).toHaveBeenCalledWith(["stop", "container-g3"]);
  expect(ports.podman).toHaveBeenCalledWith(["start", "container-g2"]);
  expect(ports.podman.mock.calls.filter(([args]) => args[0] === "rm")).toEqual([]);
  expect(await readPrivateText(fixture.recordPath)).toEqual(fixture.stored);
});

it("recreates a pruned session from its definition with saved grants instead of a checkpoint", async () => {
  const fixture = await resumeFixture();
  const record = JSON.parse(fixture.stored.text);
  await writeFile(
    fixture.recordPath,
    JSON.stringify({
      ...record,
      containerPrunedAtUnixMs: Date.now(),
    }),
  );
  await fixture.resumed.start();
  expect(fixture.confirm).not.toHaveBeenCalled();
  expect(ports.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      mounts: fixture.approvedMounts,
      resolved: fixture.resumed.options.resolved,
      generation: 3,
      previousContainer: undefined,
      checkpointImage: undefined,
    }),
  );
  expect(ports.podman).not.toHaveBeenCalled();
  const saved = JSON.parse((await readPrivateText(fixture.recordPath))!.text);
  expect(saved.generation).toBe(3);
  expect(saved.containerPrunedAtUnixMs).toBeUndefined();
  expect(saved.inactiveSinceUnixMs).toBeUndefined();
});

it("retains replaced-source approval when resuming after pruning without committing a missing container", async () => {
  const fixture = await resumeFixture();
  await fixture.replaceFile();
  await writeFile(
    fixture.recordPath,
    JSON.stringify({
      ...JSON.parse(fixture.stored.text),
      containerPrunedAtUnixMs: Date.now(),
    }),
  );
  await fixture.resumed.start();
  expect(fixture.confirm).toHaveBeenCalledTimes(1);
  expect(ports.create).toHaveBeenCalledWith(
    expect.objectContaining({
      generation: 3,
      checkpointImage: undefined,
      previousContainer: undefined,
    }),
  );
  expect(ports.podman).not.toHaveBeenCalled();
});

it("does not restart a pruned container when fresh recreation fails", async () => {
  const fixture = await resumeFixture();
  const prunedRecord = {
    ...JSON.parse(fixture.stored.text),
    containerPrunedAtUnixMs: Date.now(),
  };
  await writeFile(fixture.recordPath, JSON.stringify(prunedRecord));
  ports.create.mockRejectedValueOnce(new Error("Fresh creation failed"));
  await expect(fixture.resumed.start()).rejects.toThrow("Fresh creation failed");
  expect(ports.podman).not.toHaveBeenCalled();
  expect(JSON.parse((await readPrivateText(fixture.recordPath))!.text)).toEqual(prunedRecord);
});

it("removes the previous generation after a successful mount change", async () => {
  const fixture = await resumeFixture();
  await fixture.resumed.start();
  ports.podman.mockClear();
  ports.podman.mockImplementation(async (args: string[]) => {
    if (args[0] === "rm") {
      expect(JSON.parse((await readPrivateText(fixture.recordPath))!.text)).toMatchObject({
        generation: 3,
        environment: { container: "container-g3" },
      });
    }
    return args[0] === "commit" ? "checkpoint-image\n" : "";
  });
  await fixture.resumed.requestMount(fixture.source, "rw", "/config.json", "Update configuration");
  expect(ports.podman).toHaveBeenCalledWith(["rm", "container-g2"]);
  expect(fixture.resumed.environment.container).toBe("container-g3");
});

it("does not remove the prior mount generation when replacement creation fails", async () => {
  const fixture = await resumeFixture();
  await fixture.resumed.start();
  ports.create.mockRejectedValueOnce(new Error("Mount recreation failed"));
  await expect(
    fixture.resumed.requestMount(fixture.source, "rw", "/config.json", "Update configuration"),
  ).rejects.toThrow("Mount recreation failed");
  expect(ports.podman).toHaveBeenCalledWith(["start", "container-g2"]);
  expect(ports.podman.mock.calls.filter(([args]) => args[0] === "rm")).toEqual([]);
  expect(fixture.resumed.generation).toBe(2);
});

it("keeps the previous generation if the updated mount record cannot be saved", async () => {
  const fixture = await resumeFixture();
  await fixture.resumed.start();
  const stored = (await readPrivateText(fixture.recordPath))!;
  const publicationLock = `${fixture.recordPath}.lock`;
  await writeFile(publicationLock, '{"pid":99999999}');
  try {
    await expect(
      fixture.resumed.requestMount(fixture.source, "rw", "/config.json", "Update configuration"),
    ).rejects.toThrow("inspect stale locks");
    expect(ports.podman).toHaveBeenCalledWith(["stop", "container-g3"]);
    expect(ports.podman).toHaveBeenCalledWith(["start", "container-g2"]);
    expect(ports.podman.mock.calls.filter(([args]) => args[0] === "rm")).toEqual([]);
    expect(await readPrivateText(fixture.recordPath)).toEqual(stored);
  } finally {
    await rm(publicationLock);
  }
});

it("prunes an expired session during startup without pruning the session being resumed", async () => {
  const fixture = await resumeFixture();
  const oldSessionId = "expired-session";
  const oldContainer = "a".repeat(64);
  const oldDirectory = join(fixture.resumed.directory, "..", sha256Hex(oldSessionId));
  const inactiveSinceUnixMs = Date.now() - inactiveSessionRetentionMs - 1000;
  const currentRecord = { ...JSON.parse(fixture.stored.text), inactiveSinceUnixMs };
  await writeFile(fixture.recordPath, JSON.stringify(currentRecord));
  await mkdir(oldDirectory);
  await writeFile(
    join(oldDirectory, "session.json"),
    JSON.stringify({
      ...currentRecord,
      sessionId: oldSessionId,
      environment: { ...currentRecord.environment, container: oldContainer },
    }),
  );
  ports.podman.mockImplementation(async (args: string[]) => {
    if (args[0] === "ps") {
      expect(args).toContain(`label=pi.sandbox.session=${oldSessionId}`);
      return `${oldContainer}\n`;
    }
    if (args[0] === "inspect") {
      return JSON.stringify([
        {
          Id: oldContainer,
          Config: { Labels: { "pi.sandbox.session": oldSessionId } },
          State: { Running: false, Status: "exited" },
        },
      ]);
    }
    return "";
  });
  await fixture.resumed.start();
  expect(ports.podman).toHaveBeenCalledWith(["rm", oldContainer]);
  expect(ports.podman).not.toHaveBeenCalledWith(["rm", "container-g2"]);
  expect(fixture.resumed.environment.container).toBe("container-g2");
});

it("records inactivity once on shutdown and does not extend retention on repeated close", async () => {
  const fixture = await resumeFixture();
  await fixture.resumed.start();
  const beforeCloseUnixMs = Date.now();
  await fixture.resumed.close();
  const stored = (await readPrivateText(fixture.recordPath))!;
  const inactiveSinceUnixMs = JSON.parse(stored.text).inactiveSinceUnixMs;
  expect(inactiveSinceUnixMs).toBeGreaterThanOrEqual(beforeCloseUnixMs);
  expect(inactiveSinceUnixMs).toBeLessThanOrEqual(Date.now());
  await fixture.resumed.close();
  expect(await readPrivateText(fixture.recordPath)).toEqual(stored);
});

it("does not roll back a successful mount change when superseded-container removal fails", async () => {
  const fixture = await resumeFixture();
  await fixture.resumed.start();
  ports.podman.mockImplementation(async (args: string[]) => {
    if (args[0] === "rm") {
      throw new Error("Removal failed");
    }
    return args[0] === "commit" ? "checkpoint-image\n" : "";
  });
  await fixture.resumed.requestMount(fixture.source, "rw", "/config.json", "Update configuration");
  expect(ports.podman).toHaveBeenCalledWith(["rm", "container-g2"]);
  expect(ports.podman).not.toHaveBeenCalledWith(["start", "container-g2"]);
  expect(fixture.resumed.generation).toBe(3);
});
