import { mkdtemp, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { verifyRuntimeInventory } from "../src/sandbox/tool-build-runtime.ts";
import { catalogTool } from "../src/sandbox/tool-catalog.ts";
import { toolImageMount } from "../src/sandbox/tool-image-mounts.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { requireToolImageMountCapability } from "../src/sandbox/tool-mount-capability.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function capabilityFixture() {
  const directory = await mkdtemp(join(tmpdir(), "tool-mount-capability-"));
  directories.push(directory);
  const artifactId = "a".repeat(64);
  const builderId = "b".repeat(64);
  const checkpointId = "c".repeat(64);
  const containerId = "d".repeat(64);
  const staticDir = `/var/lib/containers/storage/overlay-containers/${containerId}/userdata`;
  const destination = "/opt/pi-mount-probe/destination";
  const imageMount = {
    Type: "image",
    Source: artifactId,
    Destination: destination,
    RW: false,
    SubPath: "/opt/pi-mount-probe/selected",
  };
  const backingMount = {
    Type: "bind",
    Source: `${staticDir}/overlay/3476953157/merge`,
    Destination: destination,
    RW: true,
    Propagation: "private",
    Options: [
      `lowerdir=/run/containers/storage/overlay-containers/${containerId}/userdata/subpath1086054437:${staticDir}/overlay/3476953157/lower`,
    ],
  };
  const inspection = { Id: containerId, StaticDir: staticDir, Mounts: [imageMount, backingMount] };
  const info = {
    host: { arch: "arm64", hostname: "fixture", kernel: "fixture", os: "linux" },
    store: {
      graphRoot: "/var/lib/containers/storage",
      runRoot: "/run/containers/storage",
      graphDriverName: "overlay",
      containerStore: { number: 0 },
    },
  };
  const version = { Client: { Version: "6.0.2" }, Server: { Version: "6.0.2" } };
  const run = vi.fn(async (args: string[], signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const [command, , inspectType, imageId] = args;
    const isImageInspection = command === "inspect" && inspectType === "image";
    const isContainerInspection = command === "inspect" && inspectType !== "image";
    const isCheckpointRun = command === "run" && args.includes(checkpointId);
    if (command === "version") {
      return JSON.stringify(version);
    }
    if (command === "info") {
      return JSON.stringify(info);
    }
    if (isImageInspection) {
      return JSON.stringify([{ Id: imageId }]);
    }
    if (isContainerInspection) {
      return JSON.stringify([inspection]);
    }
    if (command === "exec") {
      return "readonly-subpath-verified\n";
    }
    if (command === "commit") {
      return `${checkpointId}\n`;
    }
    if (isCheckpointRun) {
      return "checkpoint-exclusion-verified\n";
    }
    return "";
  });
  const build = vi.fn(async () => artifactId);
  const options = { directory, builderImageId: builderId, ports: { build }, run };
  return { options, build, run, inspection, imageMount, backingMount, info, version };
}

it("verifies the Podman 6.0.2 image descriptor and owned read-only overlay backing", async () => {
  const fixture = await capabilityFixture();
  await requireToolImageMountCapability(fixture.options);
  const invocation = fixture.run.mock.calls.find(
    ([args]) => args[0] === "run" && args.includes("--detach"),
  )![0];
  expect(invocation).toContain(
    `type=image,source=${"a".repeat(64)},subpath=/opt/pi-mount-probe/selected,destination=/opt/pi-mount-probe/destination,rw=false`,
  );
  const verification = fixture.run.mock.calls.find(([args]) => args[0] === "exec")![0];
  expect(verification.join(" ")).toContain("/proc/self/mountinfo");
  expect(verification.join(" ")).toContain("printf corrupted");
  expect(fixture.run.mock.calls.find(([args]) => args[0] === "commit")![0]).toContain(
    "--include-volumes=false",
  );
  expect(fixture.run.mock.calls.filter(([args]) => args[0] === "rmi")).toHaveLength(2);
});

it.each([
  {
    scenario: "explicit read-only mount",
    mountOptions: "ro,relatime",
    filesystem: "ext4",
    superOptions: "rw",
    mountIsAccepted: true,
  },
  {
    scenario: "lower-only overlay",
    mountOptions: "rw,relatime",
    filesystem: "overlay",
    superOptions: "rw,lowerdir=/a:/b",
    mountIsAccepted: true,
  },
  {
    scenario: "writable overlay",
    mountOptions: "rw",
    filesystem: "overlay",
    superOptions: "rw,lowerdir=/a,upperdir=/upper,workdir=/work",
    mountIsAccepted: false,
  },
  {
    scenario: "writable ordinary mount",
    mountOptions: "rw",
    filesystem: "ext4",
    superOptions: "rw",
    mountIsAccepted: false,
  },
])(
  "probe and runtime AWK agree on $scenario",
  async ({ mountOptions, filesystem, superOptions, mountIsAccepted }) => {
    const fixture = await capabilityFixture();
    await requireToolImageMountCapability(fixture.options);
    const probeArguments = fixture.run.mock.calls.find(([args]) => args[0] === "exec")![0];
    const runtimeRun = vi.fn(async (_args: string[]) => "");
    const runtimeInventory = {
      version: 1 as const,
      revision: "fixture",
      platform: "fixture",
      tools: [],
    };
    const runtimeMount = toolImageMount(catalogTool("node-runtime", "24.21.0"), "a".repeat(64));
    await verifyRuntimeInventory({
      run: runtimeRun,
      container: "fixture",
      user: "root",
      inventory: runtimeInventory,
      toolImageMounts: [runtimeMount],
    });
    const runtimeArguments = runtimeRun.mock.calls[0]![0];
    const mountinfo = `1 0 0:1 / /tool ${mountOptions} - ${filesystem} source ${superOptions}\n`;
    const probeScript = probeArguments[probeArguments.indexOf("-c") + 1]!;
    const runtimeScript = runtimeArguments[runtimeArguments.indexOf("-c") + 1]!;
    const awkProgramFrom = (script: string) =>
      script.match(/awk -v [^\n]+ '\n([\s\S]*?)\n\s*' \/proc\/self\/mountinfo/)![1]!;
    const probeAwkProgram = awkProgramFrom(probeScript);
    const runtimeAwkProgram = awkProgramFrom(runtimeScript);
    const probeResult = spawnSync("awk", ["-v", "path=/tool", probeAwkProgram], {
      input: mountinfo,
    });
    const runtimeResult = spawnSync("awk", ["-v", "destination=/tool", runtimeAwkProgram], {
      input: mountinfo,
    });
    expect(probeResult.status).toBe(mountIsAccepted ? 0 : 1);
    expect(runtimeResult.status).toBe(mountIsAccepted ? 0 : 1);
  },
);

it("accepts engines that expose only the logical image mount", async () => {
  const fixture = await capabilityFixture();
  fixture.inspection.Mounts = [fixture.imageMount];
  await requireToolImageMountCapability(fixture.options);
});

it("shares one complete cold capability probe and ignores volatile store counts", async () => {
  const fixture = await capabilityFixture();
  const { promise: buildWait, resolve: finishBuild } = Promise.withResolvers<void>();
  fixture.build.mockImplementation(async () => {
    await buildWait;
    return "a".repeat(64);
  });
  const first = requireToolImageMountCapability(fixture.options);
  await vi.waitFor(() => expect(fixture.build).toHaveBeenCalledOnce());
  const second = requireToolImageMountCapability(fixture.options);
  finishBuild();
  await Promise.all([first, second]);
  fixture.info.store.containerStore.number = 99;
  await requireToolImageMountCapability(fixture.options);
  expect(fixture.build).toHaveBeenCalledOnce();
});

it.each(["server-version", "graph-root", "storage-driver"])(
  "invalidates cached support when %s changes",
  async (change) => {
    const fixture = await capabilityFixture();
    await requireToolImageMountCapability(fixture.options);
    if (change === "server-version") {
      fixture.version.Server.Version = "6.0.3";
    } else if (change === "graph-root") {
      fixture.info.store.graphRoot = "/different/store";
    } else {
      fixture.info.store.graphDriverName = "vfs";
    }
    await requireToolImageMountCapability(fixture.options);
    expect(fixture.build).toHaveBeenCalledTimes(2);
  },
);

it.each(["writable-image", "wrong-subpath", "foreign-backing", "writable-overlay", "extra-mount"])(
  "rejects %s without caching capability",
  async (scenario) => {
    const fixture = await capabilityFixture();
    if (scenario === "writable-image") {
      fixture.imageMount.RW = true;
    } else if (scenario === "wrong-subpath") {
      fixture.imageMount.SubPath = "/outside";
    } else if (scenario === "foreign-backing") {
      fixture.backingMount.Source = "/host/private";
    } else if (scenario === "writable-overlay") {
      fixture.backingMount.Options.push("upperdir=/writable");
    } else {
      fixture.inspection.Mounts.push({ ...fixture.backingMount });
    }
    await expect(requireToolImageMountCapability(fixture.options)).rejects.toMatchObject({
      kind: "unsupported",
      phase: "image mount inspection",
    });
    expect(
      (await readdir(join(fixture.options.directory, "capabilities"))).filter((path) =>
        path.endsWith(".json"),
      ),
    ).toEqual([]);
    expect(fixture.run.mock.calls.some(([args]) => args[0] === "rm")).toBe(true);
  },
);

it("reports engine discovery failure as unavailable rather than unsupported", async () => {
  const fixture = await capabilityFixture();
  fixture.run.mockRejectedValueOnce(new Error("cannot write uid_map: operation not permitted"));
  await expect(requireToolImageMountCapability(fixture.options)).rejects.toMatchObject({
    kind: "unavailable",
    phase: "backend discovery",
  });
  expect(fixture.build).not.toHaveBeenCalled();
});

it("does not cache transient artifact build failures and retries on the next attempt", async () => {
  const fixture = await capabilityFixture();
  fixture.build.mockRejectedValueOnce(new Error("engine connection reset"));
  await expect(requireToolImageMountCapability(fixture.options)).rejects.toMatchObject({
    kind: "unavailable",
    phase: "artifact construction",
  });
  await requireToolImageMountCapability(fixture.options);
  expect(fixture.build).toHaveBeenCalledTimes(2);
});

it("cleans up owned resources after caller cancellation without caching success", async () => {
  const fixture = await capabilityFixture();
  const controller = new AbortController();
  const reason = new Error("owner retired");
  fixture.build.mockImplementation(async () => {
    controller.abort(reason);
    throw reason;
  });
  await expect(
    requireToolImageMountCapability({ ...fixture.options, signal: controller.signal }),
  ).rejects.toBe(reason);
  const cleanup = fixture.run.mock.calls.filter(([args]) => args[0] === "rm" || args[0] === "rmi");
  expect(cleanup).toHaveLength(3);
  expect(cleanup.every(([, signal]) => signal && !signal.aborted)).toBe(true);
});
