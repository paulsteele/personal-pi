import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SandboxSession } from "../src/sandbox/session.ts";
import type { ResolvedDefinition } from "../src/sandbox/definition.ts";
import { readPrivateText } from "../src/sandbox/storage.ts";
import { sessionImageName } from "../src/sandbox/container-identity.ts";
import { SavedToolArtifactUnavailableError } from "../src/sandbox/tool-image-mounts.ts";
import {
  SandboxStartupUI,
  type SandboxStartupDisplay,
  type SandboxStartupProgress,
} from "../src/sandbox/startup-ui.ts";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

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
const startupCleanupListings = new Set(["ps", "images"]);
const engineChanges = () =>
  ports.podman.mock.calls.filter(([args]) => !startupCleanupListings.has(args[0]));
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
  const toolImageMounts = [
    {
      toolId: "node-runtime",
      version: "24.21.0",
      imageId: "a".repeat(64),
      subpath: "/opt/pi-tools/node-runtime/24.21.0",
      destination: "/opt/pi-tools/node-runtime/24.21.0",
      readOnly: true,
    },
  ];
  ports.create.mockImplementation(async ({ generation, checkpointToolImageMounts }) => ({
    container: `container-g${generation}`,
    image: "node",
    user: "root",
    workspace: root,
    configuration: {},
    toolImageMounts: checkpointToolImageMounts ?? toolImageMounts,
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
  await original.close("reload");
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

it("reattaches the saved tool artifact identities on same-generation resume", async () => {
  const fixture = await resumeFixture();
  const savedMounts = JSON.parse(fixture.stored.text).environment.toolImageMounts;
  await fixture.resumed.start();
  expect(ports.create.mock.calls[0]![0].checkpointToolImageMounts).toEqual(savedMounts);
  expect(fixture.resumed.environment.toolImageMounts).toEqual(savedMounts);
});

it("preserves tool artifact identities when rebinding a replaced configuration file", async () => {
  const fixture = await resumeFixture();
  const savedMounts = JSON.parse(fixture.stored.text).environment.toolImageMounts;
  await fixture.replaceFile();
  await fixture.resumed.start();
  expect(ports.create.mock.calls[0]![0].checkpointToolImageMounts).toEqual(savedMounts);
  expect(ports.create.mock.calls[0]![0].checkpointImage).toBe("checkpoint-image");
  expect(fixture.resumed.environment.toolImageMounts).toEqual(savedMounts);
});

async function legacyToolingResumeFixture() {
  const fixture = await resumeFixture();
  const legacyRecord = JSON.parse(fixture.stored.text);
  delete legacyRecord.environment.toolImageMounts;
  await writeFile(fixture.recordPath, JSON.stringify(legacyRecord));
  fixture.resumed.options.resolved.revision = "mounted-tooling-revision";
  fixture.resumed.options.resolved.baseRevision = "original";
  return fixture;
}

it("requires approval to migrate an older session with copied tools and preserves the saved record on denial", async () => {
  const fixture = await legacyToolingResumeFixture();
  const legacyStored = await readPrivateText(fixture.recordPath);
  fixture.confirm.mockResolvedValue(false);
  await expect(fixture.resumed.start()).rejects.toThrow("Tooling rebuild was not approved");
  expect(ports.create).not.toHaveBeenCalled();
  expect(await readPrivateText(fixture.recordPath)).toEqual(legacyStored);
});

it("offers a rebuild with the saved host binds when the base definition changed", async () => {
  const fixture = await resumeFixture();
  fixture.resumed.options.resolved.revision = "edited-base-revision";
  fixture.resumed.options.resolved.baseRevision = "edited-base";
  await fixture.resumed.start();
  expect(fixture.confirm).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("The devcontainer base definition changed. Rebuild this session"),
    expect.any(AbortSignal),
  );
  expect(ports.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ mounts: fixture.approvedMounts, checkpointImage: undefined }),
  );
  expect(JSON.parse((await readPrivateText(fixture.recordPath))!.text).baseDefinitionRevision).toBe(
    "edited-base",
  );
});

it("keeps the saved session when the base-definition rebuild is declined", async () => {
  const fixture = await resumeFixture();
  fixture.resumed.options.resolved.revision = "edited-base-revision";
  fixture.resumed.options.resolved.baseRevision = "edited-base";
  fixture.confirm.mockResolvedValue(false);
  await expect(fixture.resumed.start()).rejects.toThrow("Base definition rebuild was not approved");
  expect(ports.create).not.toHaveBeenCalled();
  expect(await readPrivateText(fixture.recordPath)).toEqual(fixture.stored);
});

it("migrates an approved older session from its definition rather than checkpointing copied tools", async () => {
  const fixture = await legacyToolingResumeFixture();
  await fixture.resumed.start();
  expect(fixture.confirm).toHaveBeenCalledWith(
    expect.stringContaining("Rebuild this session"),
    expect.any(AbortSignal),
  );
  expect(ports.create.mock.calls[0]![0].checkpointImage).toBeUndefined();
  expect(ports.create.mock.calls[0]![0].checkpointToolImageMounts).toBeUndefined();
  expect(ports.podman.mock.calls.some(([args]) => args[0] === "commit")).toBe(false);
  expect(fixture.resumed.environment.toolImageMounts).toHaveLength(1);
});

it("preserves saved state when missing-artifact recovery approval is denied", async () => {
  const fixture = await resumeFixture();
  const mount = JSON.parse(fixture.stored.text).environment.toolImageMounts[0];
  ports.create.mockRejectedValueOnce(new SavedToolArtifactUnavailableError(mount, "image missing"));
  fixture.confirm.mockResolvedValue(false);
  await expect(fixture.resumed.start()).rejects.toThrow("Saved tool artifact unavailable");
  await fixture.resumed.close();
  expect(await readPrivateText(fixture.recordPath)).toEqual(fixture.stored);
  expect(ports.create).toHaveBeenCalledTimes(1);
  expect(engineChanges()).toEqual([]);
});

it("preserves saved state when missing-artifact recovery approval is cancelled", async () => {
  const fixture = await resumeFixture();
  const mount = JSON.parse(fixture.stored.text).environment.toolImageMounts[0];
  ports.create.mockRejectedValueOnce(new SavedToolArtifactUnavailableError(mount, "image missing"));
  fixture.confirm.mockRejectedValue(new Error("Recovery cancelled"));
  await expect(fixture.resumed.start()).rejects.toThrow("Recovery cancelled");
  await fixture.resumed.close();
  expect(await readPrivateText(fixture.recordPath)).toEqual(fixture.stored);
  expect(ports.create).toHaveBeenCalledTimes(1);
  expect(engineChanges()).toEqual([]);
});

it("restores the previous container when an approved missing-artifact replacement fails", async () => {
  const fixture = await resumeFixture();
  const mount = JSON.parse(fixture.stored.text).environment.toolImageMounts[0];
  ports.create.mockRejectedValueOnce(new SavedToolArtifactUnavailableError(mount, "image missing"));
  ports.create.mockRejectedValueOnce(new Error("Replacement failed"));
  await expect(fixture.resumed.start()).rejects.toThrow("Replacement failed");
  await fixture.resumed.close();
  expect(await readPrivateText(fixture.recordPath)).toEqual(fixture.stored);
  expect(ports.create).toHaveBeenCalledTimes(2);
  expect(engineChanges().map(([args]) => args)).toEqual([
    ["stop", "--time=0", "container-g2"],
    ["start", "container-g2"],
  ]);
});

it("offers missing-artifact rebuild approval during startup without needing a ready session", async () => {
  const fixture = await resumeFixture();
  const mount = JSON.parse(fixture.stored.text).environment.toolImageMounts[0];
  ports.create.mockRejectedValueOnce(new SavedToolArtifactUnavailableError(mount, "image missing"));
  await fixture.resumed.start();
  expect(fixture.confirm).toHaveBeenCalledWith(
    expect.stringContaining("saved host binds"),
    expect.any(AbortSignal),
  );
  expect(ports.create).toHaveBeenCalledTimes(2);
  expect(ports.create.mock.calls[1]![0]).toMatchObject({
    mounts: fixture.approvedMounts,
    checkpointImage: undefined,
    checkpointInventory: undefined,
    checkpointToolImageMounts: undefined,
    generation: 3,
  });
  expect(fixture.resumed.environment.container).toBe("container-g3");
});

it("does not save denied port authority or reuse it on the next startup", async () => {
  const fixture = await resumeFixture();
  const options = {
    ...fixture.resumed.options,
    sessionId: "port-session",
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
  expect(fixture.confirm).toHaveBeenCalledWith(
    expect.stringContaining("3000"),
    expect.any(AbortSignal),
  );
  fixture.confirm.mockClear();
  fixture.confirm.mockResolvedValue(true);
  const approvedStartup = new SandboxSession(options);
  sessions.push(approvedStartup);
  await approvedStartup.start();
  expect(fixture.confirm).toHaveBeenCalledWith(
    expect.stringContaining("3000"),
    expect.any(AbortSignal),
  );
  expect(
    JSON.parse((await readPrivateText(join(approvedStartup.directory, "session.json")))!.text)
      .approvedPorts,
  ).toEqual([3000]);
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
  expect(engineChanges()).toEqual([]);
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
  expect(ports.podman).toHaveBeenCalledWith(
    ["stop", "--time=0", "container-g2"],
    expect.any(AbortSignal),
    undefined,
    15_000,
  );
  expect(ports.podman).toHaveBeenCalledWith(
    [
      "commit",
      "--include-volumes=false",
      "container-g2",
      `${sessionImageName("session")}-checkpoint:g3`,
    ],
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

  await fixture.resumed.close("reload");
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
  expect(engineChanges()).toEqual([]);
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
  expect(progress.stage).toHaveBeenLastCalledWith("Devcontainer mounts updated.");
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
  expect(run.mock.calls[0]![2]?.aborted).toBe(false);
  expect(progress.stage).toHaveBeenCalledWith("Stopping devcontainer language servers…");
  expect(progress.stage).toHaveBeenCalledWith("Waiting for active guest processes…");
  expect(progress.stage).toHaveBeenCalledWith("Stopping the previous devcontainer…");
  expect(progress.stage).toHaveBeenCalledWith("Starting rebuilt devcontainer port forwarders…");
  expect(progress.stage).toHaveBeenCalledWith("Saving rebuilt devcontainer session…");
  expect(progress.stage).toHaveBeenCalledWith("Removing superseded devcontainer…");
  expect(progress.stage).toHaveBeenLastCalledWith("Devcontainer rebuild complete.");
});

it("keeps the mount progress screen visible until the replacement container is ready", async () => {
  type CustomUI = ExtensionContext["ui"]["custom"];
  const presentations: Array<{ finished: boolean }> = [];
  const custom = vi.fn(
    (factory: Parameters<CustomUI>[0], options?: Parameters<CustomUI>[1]) =>
      new Promise<unknown>((resolve) => {
        const presentation = { finished: false };
        presentations.push(presentation);
        factory(
          { terminal: { rows: 20 }, requestRender: vi.fn() } as never,
          { fg: (_color: string, text: string) => text } as Theme,
          {} as never,
          (result) => {
            presentation.finished = true;
            resolve(result);
          },
        );
        options?.onHandle?.({ setHidden: vi.fn() } as never);
      }),
  );
  const startup = new SandboxStartupUI(
    () =>
      ({
        mode: "tui",
        hasUI: true,
        cwd: "/project",
        ui: { custom, notify: vi.fn() },
      }) as unknown as ExtensionContext,
  );
  const fixture = await resumeFixture(startup);
  await fixture.resumed.start();
  const source = join(fixture.source, "..", "additional.json");
  await writeFile(source, '{"additional":true}');
  const { promise: recreationWait, resolve: completeRecreation } = Promise.withResolvers<void>();
  ports.create.mockClear();
  ports.create.mockImplementationOnce(async ({ generation }) => {
    await recreationWait;
    return {
      container: `container-g${generation}`,
      image: "node",
      user: "root",
      workspace: fixture.resumed.options.resolved.startupDirectory,
      configuration: {},
    };
  });
  const mountRequest = fixture.resumed.requestMount(
    source,
    "ro",
    "/additional.json",
    "Read additional configuration",
  );
  try {
    await vi.waitFor(() => expect(ports.create).toHaveBeenCalledOnce());
    expect(presentations).toHaveLength(4);
    expect(presentations.at(-1)!.finished).toBe(false);
    expect(ports.podman).toHaveBeenCalledWith(
      ["stop", "--time=0", "container-g2"],
      expect.any(AbortSignal),
      undefined,
      15_000,
    );
    expect(ports.create).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 3,
        checkpointImage: "checkpoint-image",
        mounts: expect.arrayContaining([
          expect.objectContaining({ source, destination: "/additional.json" }),
        ]),
      }),
    );
  } finally {
    completeRecreation();
    await mountRequest;
  }
  expect(presentations.at(-1)!.finished).toBe(true);
  expect(fixture.resumed.environment.container).toBe("container-g3");
  expect(JSON.parse((await readPrivateText(fixture.recordPath))!.text)).toMatchObject({
    generation: 3,
    environment: { container: "container-g3" },
    mounts: expect.arrayContaining([
      expect.objectContaining({ source, destination: "/additional.json" }),
    ]),
  });
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
  expect(ports.podman).toHaveBeenCalledWith(
    ["stop", "--time=0", "container-g3"],
    undefined,
    undefined,
    15_000,
  );
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
      checkpointToolImageMounts: record.environment.toolImageMounts,
    }),
  );
  expect(engineChanges()).toEqual([]);
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
  expect(engineChanges()).toEqual([]);
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
  expect(engineChanges()).toEqual([]);
  expect(JSON.parse((await readPrivateText(fixture.recordPath))!.text)).toEqual(prunedRecord);
});

it("stops immediately before checkpointing a mount change and passes cancellation to the checkpoint", async () => {
  const fixture = await resumeFixture();
  await fixture.resumed.start();
  ports.podman.mockClear();
  const cancellation = new AbortController();
  const stages: string[] = [];
  fixture.resumed.options.startup = {
    run: async (_title, operation) =>
      operation({ stage: (text) => stages.push(text), output: () => {} }),
  };
  await fixture.resumed.requestMount(
    fixture.source,
    "rw",
    "/config.json",
    "Update configuration",
    cancellation.signal,
  );
  expect(ports.podman.mock.calls[0]).toEqual([
    ["stop", "--time=0", "container-g2"],
    expect.any(AbortSignal),
    undefined,
    15_000,
  ]);
  expect(ports.podman.mock.calls[1]).toEqual([
    [
      "commit",
      "--include-volumes=false",
      "container-g2",
      `${sessionImageName("session")}-checkpoint:g3`,
    ],
    expect.any(AbortSignal),
  ]);
  expect(stages.indexOf("Stopping the previous devcontainer…")).toBeLessThan(
    stages.indexOf("Checkpointing container-local state…"),
  );
  expect(fixture.resumed.environment.container).toBe("container-g3");
});

it("cancels a stalled mount checkpoint and restores the previous generation without publishing grants", async () => {
  const fixture = await resumeFixture();
  await fixture.resumed.start();
  const stored = await readPrivateText(fixture.recordPath);
  const cancellation = new AbortController();
  const checkpointStarted = vi.fn();
  ports.podman.mockImplementation(async (args: string[], signal?: AbortSignal) => {
    if (args[0] !== "commit") {
      return "";
    }
    checkpointStarted();
    return new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  ports.create.mockClear();
  const request = fixture.resumed.requestMount(
    fixture.source,
    "rw",
    "/config.json",
    "Update configuration",
    cancellation.signal,
  );
  const cancelledRequest = expect(request).rejects.toThrow("Cancelled checkpoint");
  await vi.waitFor(() => expect(checkpointStarted).toHaveBeenCalledOnce());
  cancellation.abort(new Error("Cancelled checkpoint"));
  await cancelledRequest;
  expect(ports.create).not.toHaveBeenCalled();
  expect(ports.podman).toHaveBeenCalledWith(["start", "container-g2"]);
  expect(fixture.resumed.environment.container).toBe("container-g2");
  expect(fixture.resumed.mounts).toEqual(fixture.approvedMounts);
  expect(await readPrivateText(fixture.recordPath)).toEqual(stored);
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
    expect(ports.podman).toHaveBeenCalledWith(
      ["stop", "--time=0", "container-g3"],
      undefined,
      undefined,
      15_000,
    );
    expect(ports.podman).toHaveBeenCalledWith(["start", "container-g2"]);
    expect(ports.podman.mock.calls.filter(([args]) => args[0] === "rm")).toEqual([]);
    expect(await readPrivateText(fixture.recordPath)).toEqual(stored);
  } finally {
    await rm(publicationLock);
  }
});

it("removes an abandoned session's container during startup without touching the session being resumed", async () => {
  const fixture = await resumeFixture();
  const abandonedSessionId = "abandoned-session";
  const abandonedContainer = "a".repeat(64);
  const resumedContainerId = "b".repeat(64);
  ports.podman.mockImplementation(async (args: string[]) => {
    if (args[0] === "ps") {
      return JSON.stringify([
        { Id: abandonedContainer, Labels: { "pi.sandbox.session": abandonedSessionId } },
        { Id: resumedContainerId, Labels: { "pi.sandbox.session": "session" } },
      ]);
    }
    return "";
  });
  await fixture.resumed.start();
  expect(ports.podman).toHaveBeenCalledWith(["rm", "--force", "--time=0", abandonedContainer]);
  expect(ports.podman).not.toHaveBeenCalledWith(["rm", "--force", "--time=0", resumedContainerId]);
  expect(fixture.resumed.environment.container).toBe("container-g2");
});

it("removes the container and session images when the session quits, and recreates on resume", async () => {
  const fixture = await resumeFixture();
  await fixture.resumed.start();
  const sessionImage = sessionImageName("session");
  ports.podman.mockImplementation(async (args: string[]) =>
    args[0] === "images" ? `${sessionImage}:latest\n${sessionImage}-checkpoint:g3\n` : "",
  );
  await fixture.resumed.close();
  expect(ports.podman).toHaveBeenCalledWith(["rm", "--force", "--time=0", "container-g2"]);
  expect(ports.podman).toHaveBeenCalledWith(["rmi", `${sessionImage}:latest`]);
  expect(ports.podman).toHaveBeenCalledWith(["rmi", `${sessionImage}-checkpoint:g3`]);
  const stored = JSON.parse((await readPrivateText(fixture.recordPath))!.text);
  expect(stored.containerPrunedAtUnixMs).toEqual(expect.any(Number));
  expect(stored.mounts).toEqual(fixture.approvedMounts);
  const nextResume = new SandboxSession({ ...fixture.resumed.options });
  sessions.push(nextResume);
  ports.create.mockClear();
  await nextResume.start();
  expect(ports.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ checkpointImage: undefined, generation: 3 }),
  );
});

it("keeps the running container across reload and reattaches it without recreating", async () => {
  const fixture = await resumeFixture();
  await fixture.resumed.start();
  await fixture.resumed.close("reload");
  expect(engineChanges()).toEqual([]);
  const reloaded = new SandboxSession({
    ...fixture.resumed.options,
    reattachRunningContainer: true,
  });
  sessions.push(reloaded);
  ports.create.mockClear();
  const inspectedContainer = {
    Id: "container-g2",
    Image: "node",
    State: { Running: true },
    Config: { Labels: { "pi.sandbox.session": "session" } },
    HostConfig: {
      Privileged: false,
      NetworkMode: "bridge",
      PidMode: "private",
      SecurityOpt: ["no-new-privileges"],
      Devices: [],
    },
    Mounts: [],
  };
  ports.podman.mockImplementation(async (args: string[]) =>
    args[0] === "inspect" ? JSON.stringify([inspectedContainer]) : "",
  );
  await reloaded.start();
  expect(ports.podman).toHaveBeenCalledWith(
    ["inspect", "--type", "container", "container-g2"],
    expect.any(AbortSignal),
  );
  expect(reloaded.environment.container).toBe("container-g2");
});

it("falls back to the normal resume when the reloaded container cannot be reattached", async () => {
  const fixture = await resumeFixture();
  await fixture.resumed.start();
  await fixture.resumed.close("reload");
  const reloaded = new SandboxSession({
    ...fixture.resumed.options,
    reattachRunningContainer: true,
  });
  sessions.push(reloaded);
  ports.create.mockClear();
  ports.podman.mockImplementation(async (args: string[]) => {
    if (args[0] === "inspect") {
      throw new Error("no such container");
    }
    return "";
  });
  await reloaded.start();
  expect(ports.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ previousContainer: "container-g2", generation: 2 }),
  );
});

it("takes over an owner lock left by an exited process", async () => {
  const fixture = await resumeFixture();
  const lockPath = join(fixture.resumed.directory, "owner.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 2 ** 22 + 12345 }));
  await fixture.resumed.start();
  expect(JSON.parse((await readPrivateText(lockPath))!.text)).toEqual({ pid: process.pid });
});

it("refuses a session whose owner lock belongs to a running process", async () => {
  const fixture = await resumeFixture();
  const lockPath = join(fixture.resumed.directory, "owner.lock");
  await writeFile(lockPath, JSON.stringify({ pid: process.ppid }));
  await expect(fixture.resumed.start()).rejects.toThrow(`owned by running process ${process.ppid}`);
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
  ports.podman.mockResolvedValue("");
});
