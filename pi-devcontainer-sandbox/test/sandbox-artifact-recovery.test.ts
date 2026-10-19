import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import sandboxExtension from "../src/sandbox-extension.ts";
import { createMountGrant } from "../src/sandbox/mounts.ts";
import { catalogTool } from "../src/sandbox/tool-catalog.ts";
import {
  SavedToolArtifactUnavailableError,
  toolImageMount,
} from "../src/sandbox/tool-image-mounts.ts";
import { sha256Hex } from "../src/sandbox/storage.ts";
import { sandboxStorageRoot } from "../src/sandbox/settings.ts";
import { defaultToolProfile, globalToolProfilePath } from "../src/sandbox/tool-profile.ts";
import type { ResolvedDefinition } from "../src/sandbox/definition.ts";

const sandboxMocks = vi.hoisted(() => ({
  create: vi.fn(),
  podman: vi.fn(),
  resolved: undefined as unknown,
}));
vi.mock("../src/sandbox/driver.ts", () => ({
  createDevcontainer: sandboxMocks.create,
  podmanOutput: sandboxMocks.podman,
}));
vi.mock("../src/sandbox/ports.ts", () => ({
  devcontainerPorts: () => [],
  startLoopbackForwarders: async () => ({ close: async () => {} }),
}));
vi.mock("../src/sandbox/definition.ts", async (original) => ({
  ...(await original<typeof import("../src/sandbox/definition.ts")>()),
  selectDefinition: async () => ({ path: "/private/devcontainer.json" }),
  resolveDefinition: async () => sandboxMocks.resolved,
}));

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("recovers a missing saved artifact through the loaded extension's startup approval", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sandbox-artifact-recovery-")));
  directories.push(directory);
  const root = join(directory, "project");
  const agentDir = join(directory, "agent");
  await mkdir(root);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const toolsPath = globalToolProfilePath(agentDir);
  await mkdir(join(agentDir, "extensions/pi-devcontainer-sandbox/global"), { recursive: true });
  await writeFile(toolsPath, JSON.stringify(defaultToolProfile()));
  const mount = await createMountGrant({
    path: root,
    destination: "/workspace",
    access: "rw",
    privateStorage: agentDir,
  });
  const toolMount = toolImageMount(catalogTool("node-runtime", "24.21.0"), "a".repeat(64));
  const resolved: ResolvedDefinition = {
    path: "/private/devcontainer.json",
    sourceText: "{}",
    revision: "unchanged",
    definition: { image: "base" },
    tier: "global",
    startupDirectory: root,
    project: { id: "b".repeat(64), kind: "projects", root },
  };
  sandboxMocks.resolved = resolved;
  const sessionDirectory = join(sandboxStorageRoot(agentDir), "sessions", sha256Hex("session"));
  await mkdir(sessionDirectory, { recursive: true });
  const recordPath = join(sessionDirectory, "session.json");
  await writeFile(
    recordPath,
    JSON.stringify({
      version: 1,
      sessionId: "session",
      startupDirectory: root,
      definitionRevision: "unchanged",
      generation: 1,
      mounts: [mount],
      environment: {
        container: "previous",
        image: "base",
        user: "root",
        workspace: "/workspace",
        configuration: {},
        toolImageMounts: [toolMount],
      },
    }),
  );
  sandboxMocks.create.mockRejectedValueOnce(
    new SavedToolArtifactUnavailableError(toolMount, "missing"),
  );
  sandboxMocks.create.mockResolvedValueOnce({
    container: "replacement",
    image: "base",
    user: "root",
    workspace: "/workspace",
    configuration: {},
    toolImageMounts: [toolMount],
  });
  sandboxMocks.podman.mockResolvedValue("");
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const select = vi.fn().mockResolvedValue("y approve once");
  const notify = vi.fn();
  sandboxExtension({
    events: { on: () => () => {}, emit() {} },
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) =>
      handlers.set(name, handler),
    registerTool() {},
    registerCommand() {},
    registerEntryRenderer() {},
  } as never);
  const ctx = {
    cwd: root,
    mode: "rpc",
    hasUI: true,
    sessionManager: { getSessionId: () => "session" },
    ui: { select, notify, setStatus() {} },
  };
  try {
    await handlers.get("session_start")!({}, ctx);
    expect(select).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/saved\s+host binds/),
      expect.any(Array),
      expect.any(Object),
    );
    expect(sandboxMocks.create).toHaveBeenCalledTimes(2);
    expect(sandboxMocks.create.mock.calls[1]![0]).toMatchObject({
      mounts: [mount],
      checkpointToolImageMounts: undefined,
      generation: 2,
    });
    const savedSession = JSON.parse(await readFile(recordPath, "utf8"));
    expect(savedSession.environment.container).toBe("replacement");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("unavailable"), "error");
  } finally {
    await handlers.get("session_shutdown")!({}, ctx);
  }
});
