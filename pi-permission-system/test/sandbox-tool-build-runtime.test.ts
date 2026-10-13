import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createToolBuildPorts,
  inspectToolPlatform,
  verifyRuntimeInventory,
} from "../src/sandbox/tool-build-runtime.ts";
import { buildContentKey } from "../src/sandbox/tool-cache.ts";
import { withPrivateLock } from "../src/sandbox/storage.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function buildFixture() {
  const directory = await mkdtemp(join(tmpdir(), "tool-build-inputs-"));
  directories.push(directory);
  const imageId = `sha256:${"a".repeat(64)}`;
  const run = vi.fn(async (args: string[]) =>
    args[0] === "inspect" ? JSON.stringify([{ Id: imageId, Config: {} }]) : "",
  );
  const ports = createToolBuildPorts({ directory, run, approvedMountArguments: [] });
  const recipe = {
    containerfile: "FROM scratch\nCOPY content.txt /content.txt\n",
    files: { "content.txt": "same input" },
  };
  const contextDirectory = join(directory, "contexts", buildContentKey(recipe));
  return { ports, recipe, run, imageId, contextDirectory };
}

it("verifies a named tool under its actual remote PATH and working directory", async () => {
  const remoteEnvironment = { PATH: "/project/tools/bin:/usr/bin" };
  const run = vi.fn(async (args: string[]) => {
    if (
      !args.includes("PATH=/project/tools/bin:/usr/bin") ||
      !args.includes("/workspace/project")
    ) {
      throw new Error("Runtime environment missing");
    }
    return "";
  });
  await verifyRuntimeInventory({
    run,
    container: "container",
    user: "developer",
    remoteEnvironment,
    workspace: "/workspace/project",
    inventory: {
      version: 1,
      revision: "tools",
      platform: "linux-arm64-debian-12-glibc",
      tools: [
        {
          id: "custom-tool",
          version: "1",
          executable: "custom-tool",
          source: "project",
          imageId: "image",
        },
      ],
    },
  });
  expect(run).toHaveBeenCalledWith(
    [
      "exec",
      "--user",
      "developer",
      "--env",
      "PATH=/project/tools/bin:/usr/bin",
      "--workdir",
      "/workspace/project",
      "container",
      "sh",
      "-c",
      'command -v "$1" >/dev/null',
      "sh",
      "custom-tool",
    ],
    undefined,
  );
});

it("retains approved image metadata mounts while keeping the platform probe mount-free", async () => {
  const approvedMount = "type=bind,source=/project,target=/workspace";
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === "inspect") {
      return JSON.stringify([
        {
          Id: "image",
          Os: "linux",
          Architecture: "arm64",
          Config: {
            Labels: { "devcontainer.metadata": JSON.stringify([{ mounts: [approvedMount] }]) },
          },
        },
      ]);
    }
    return args[0] === "run" ? "ID=debian\nVERSION_ID=12\nPI_LIBC=glibc\n" : "";
  });
  expect(
    await inspectToolPlatform({ run, imageId: "image", approvedMountArguments: [approvedMount] }),
  ).toMatchObject({
    architecture: "arm64",
    distribution: "debian",
    release: "12",
  });
  const probe = run.mock.calls.find(([args]) => args[0] === "run")![0];
  expect(probe).not.toContain("--mount");
  expect(probe).not.toContain(approvedMount);
});

it("serializes builds sharing generated inputs so lock files cannot change a sibling build context", async () => {
  const fixture = await buildFixture();
  const { promise: firstBuildWait, resolve: releaseFirstBuild } = Promise.withResolvers<void>();
  const startedBuilds: string[][] = [];
  fixture.run.mockImplementation(async (args) => {
    if (args[0] === "build") {
      startedBuilds.push(args);
      if (startedBuilds.length === 1) {
        await firstBuildWait;
      }
      return "";
    }
    return JSON.stringify([{ Id: fixture.imageId, Config: {} }]);
  });
  const first = fixture.ports.build(fixture.recipe, "localhost/pi-test:first");
  await vi.waitFor(() => expect(startedBuilds).toHaveLength(1));
  const second = fixture.ports.build(fixture.recipe, "localhost/pi-test:second");
  releaseFirstBuild();
  expect(await first).toBe(fixture.imageId);
  expect(await second).toBe(fixture.imageId);
  expect(startedBuilds).toHaveLength(2);
});

it("cancels a build waiting for generated-context ownership before invoking the engine", async () => {
  const fixture = await buildFixture();
  const { promise: lockWait, resolve: releaseLock } = Promise.withResolvers<void>();
  const lockAcquired = vi.fn();
  const owner = withPrivateLock(`${fixture.contextDirectory}.build.lock`, async () => {
    lockAcquired();
    await lockWait;
  });
  await vi.waitFor(() => expect(lockAcquired).toHaveBeenCalledOnce());
  const cancellation = new AbortController();
  try {
    const pending = fixture.ports.build(
      fixture.recipe,
      "localhost/pi-test:cancelled",
      cancellation.signal,
    );
    const rejection = expect(pending).rejects.toThrow();
    cancellation.abort(new Error("Cancelled build"));
    await rejection;
    expect(fixture.run).not.toHaveBeenCalled();
  } finally {
    releaseLock();
    await owner;
  }
});
