import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDevcontainer } from "../src/sandbox/driver.ts";
import { catalogTool } from "../src/sandbox/tool-catalog.ts";
import { toolImageMount } from "../src/sandbox/tool-image-mounts.ts";

const mocks = vi.hoisted(() => ({ cli: vi.fn(), adapter: vi.fn(), exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
vi.mock("node:util", async (importOriginal) => {
  const originalUtil = await importOriginal<typeof import("node:util")>();
  return {
    ...originalUtil,
    promisify: (callback: typeof mocks.exec) => {
      if (callback !== mocks.exec) {
        return originalUtil.promisify(callback);
      }
      return (...args: unknown[]) => {
        const execution = Promise.withResolvers<{ stdout: string; stderr: string }>();
        const child = mocks.exec(...args, (error: Error | null, stdout: string, stderr: string) => {
          if (error) {
            execution.reject(error);
          } else {
            execution.resolve({ stdout, stderr });
          }
        });
        return Object.assign(execution.promise, { child });
      };
    },
  };
});
vi.mock("../src/sandbox/devcontainer-cli.ts", () => ({
  cliHostEnvironment: () => ({}),
  runDevcontainerCli: mocks.cli,
}));
vi.mock("../src/sandbox/engine-server.ts", () => ({ startEngineAdapter: mocks.adapter }));
const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function mountedDriverFixture() {
  const directory = await mkdtemp(join(tmpdir(), "mounted-driver-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const tool = catalogTool("node-runtime", "24.21.0");
  const mount = toolImageMount(tool, "a".repeat(64));
  const imageId = "b".repeat(64);
  const containerId = "c".repeat(64);
  const hostMount = {
    source: workspace,
    destination: "/workspace",
    access: "rw" as const,
    identity: "1:2",
    kind: "directory" as const,
  };
  const image = { Id: imageId, Config: { User: "root" } };
  const details = {
    Id: containerId,
    Image: imageId,
    State: { Running: true },
    Config: { Labels: { "pi.sandbox.session": "session" } },
    HostConfig: {
      Privileged: false,
      NetworkMode: "bridge",
      PidMode: "",
      SecurityOpt: ["no-new-privileges"],
      Devices: [],
    },
    EffectiveCaps: [],
    Mounts: [
      { Type: "bind", Source: workspace, Destination: "/workspace", RW: true },
      {
        Type: "image",
        Source: mount.imageId,
        Destination: mount.destination,
        SubPath: mount.subpath,
        RW: false,
      },
    ],
  };
  const engineCalls: string[][] = [];
  mocks.exec.mockImplementation((_command, args: string[], _options, callback) => {
    engineCalls.push(args);
    const [operation] = args;
    let stdout = "";
    if (operation === "inspect") {
      const target = args.at(-1);
      if (target === containerId) {
        stdout = JSON.stringify([details]);
      } else if (target === mount.imageId) {
        stdout = JSON.stringify([{ Id: mount.imageId, Config: {} }]);
      } else {
        stdout = JSON.stringify([image]);
      }
    }
    callback(null, stdout, "");
    return {
      stdout: {
        on: (_event: string, listener: (chunk: Buffer) => void) => listener(Buffer.from(stdout)),
      },
      stderr: { on() {} },
    };
  });
  let injectedMounts: unknown;
  mocks.adapter.mockImplementation(async ({ authority }) => ({
    environment: {},
    close: async () => {},
    authority,
  }));
  mocks.cli.mockImplementation(async ({ args }) => {
    if (args[0] === "up") {
      injectedMounts = mocks.adapter.mock.calls[0]![0].authority.toolImageMounts;
      return JSON.stringify({
        outcome: "success",
        containerId,
        remoteUser: "root",
        remoteWorkspaceFolder: "/workspace",
      });
    }
    return JSON.stringify({ PATH: "/usr/bin:/bin" });
  });
  const options = {
    resolved: {
      path: join(directory, "devcontainer.json"),
      sourceText: "{}",
      revision: "revision",
      tier: "global" as const,
      definition: { image: imageId },
      startupDirectory: workspace,
      project: { kind: "projects" as const, id: "d".repeat(64), root: workspace },
    },
    mounts: [hostMount],
    sessionId: "session",
    directory: join(directory, "session"),
    privateStorage: join(directory, "private"),
    hostEnvironment: [],
    confirmHostInitialization: async () => true,
    checkpointImage: imageId,
    checkpointToolImageMounts: [mount],
    checkpointInventory: {
      version: 1 as const,
      revision: "e".repeat(64),
      platform: "fixture",
      tools: [
        {
          id: tool.id,
          version: tool.version,
          executable: tool.executable,
          source: "global" as const,
          imageId: mount.imageId,
        },
      ],
    },
  };
  return { options, details, engineCalls, mount, injectedMounts: () => injectedMounts };
}

it("restores saved artifact mounts before devcontainer lifecycle execution without adding them to metadata", async () => {
  const fixture = await mountedDriverFixture();
  const environment = await createDevcontainer(fixture.options);
  expect(fixture.injectedMounts()).toEqual([fixture.mount]);
  expect(environment.toolImageMounts).toEqual([fixture.mount]);
  expect(environment.remoteEnvironment?.PATH).toBe("/usr/bin:/bin");
  const destinationProbe = fixture.engineCalls.find((args) => args[0] === "run")!;
  expect(destinationProbe).not.toContain("--mount");
  const runtimeChecks = fixture.engineCalls.filter((args) => args[0] === "exec");
  expect(runtimeChecks.some((args) => args.join(" ").includes("/proc/self/mountinfo"))).toBe(true);
});

it("reports real startup stages while keeping inspection JSON in diagnostics only", async () => {
  const fixture = await mountedDriverFixture();
  const progress = vi.fn();
  const stage = vi.fn();
  const diagnostic = vi.fn();
  await createDevcontainer({ ...fixture.options, progress, stage, diagnostic });
  expect(stage.mock.calls.map(([text]) => text)).toEqual([
    "Preparing devcontainer configuration…",
    "Validating development image…",
    "Validating tool artifact mounts and destinations…",
    "Starting devcontainer and running lifecycle hooks…",
    "Loading container environment…",
    "Verifying provisioned runtime executables…",
  ]);
  expect(progress).not.toHaveBeenCalled();
  expect(diagnostic).toHaveBeenCalledWith(
    expect.stringContaining('podman inspect stdout: [{"Id":'),
  );
  expect(fixture.engineCalls.filter((args) => args[0] === "inspect").length).toBeGreaterThan(0);
});

it("reports a missing saved artifact without starting a replacement container", async () => {
  const fixture = await mountedDriverFixture();
  const originalExec = mocks.exec.getMockImplementation()!;
  mocks.exec.mockImplementation((command, args: string[], options, callback) => {
    if (args[0] === "inspect" && args.at(-1) === fixture.mount.imageId) {
      callback(new Error("image not known"), "", "");
      return { stdout: { on() {} }, stderr: { on() {} } };
    }
    return originalExec(command, args, options, callback);
  });
  await expect(createDevcontainer(fixture.options)).rejects.toThrow(
    "Saved tool artifact unavailable",
  );
  expect(mocks.cli.mock.calls.some(([{ args }]) => args[0] === "up")).toBe(false);
});

it("refuses reused containers with writable tool image descriptors", async () => {
  const fixture = await mountedDriverFixture();
  fixture.details.Mounts[1]!.RW = true;
  await expect(createDevcontainer(fixture.options)).rejects.toThrow(
    "does not match tool image mount",
  );
});
