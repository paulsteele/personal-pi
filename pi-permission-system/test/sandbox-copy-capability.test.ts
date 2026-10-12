import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveToolCopyMode } from "../src/sandbox/tool-copy-capability.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("shares one complete cold copy-capability probe between concurrent sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-copy-capability-"));
  directories.push(directory);
  const { promise: sourceBuildWait, resolve: finishSourceBuild } = Promise.withResolvers<void>();
  const build = vi.fn(async () => {
    await sourceBuildWait;
    return `sha256:${"a".repeat(64)}`;
  });
  const versionResponse = '{"version":"fixture"}';
  const inspectedImages = [
    { RootFS: { Layers: ["base-one", "shared-copy"] } },
    { RootFS: { Layers: ["base-two", "shared-copy"] } },
  ];
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === "version") {
      return versionResponse;
    }
    return JSON.stringify(inspectedImages);
  });
  const options = {
    directory, builderImageId: `sha256:${"b".repeat(64)}`, run,
    ports: { build, inspect: async () => undefined, validateImage: async () => {}, resolveBuilder: async () => "builder" },
  };
  const first = resolveToolCopyMode(options);
  await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
  const second = resolveToolCopyMode(options);
  finishSourceBuild();
  expect(await first).toBe("linked");
  expect(await second).toBe("linked");
  expect(build).toHaveBeenCalledTimes(3);
  expect(run.mock.calls.filter(([args]) => args[0] === "inspect")).toHaveLength(1);
});
