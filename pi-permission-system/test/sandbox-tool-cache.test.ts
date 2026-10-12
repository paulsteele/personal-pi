import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  buildContentKey,
  ensureCachedImage,
  equippedBaseKey,
  projectImageKey,
  toolArtifactKey,
  type ToolArtifactInput,
} from "../src/sandbox/tool-cache.ts";
import { readPrivateText } from "../src/sandbox/storage.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const artifact: ToolArtifactInput = {
  toolId: "pyright",
  version: "1.1.414",
  platformKey: "linux-arm64-alpine-3.23-musl",
  builderImageId: `sha256:${"a".repeat(64)}`,
  recipe: "FROM builder\nRUN install-pyright\n",
  files: { "install.sh": "install-pyright" },
  dependencyImageIds: { node: `sha256:${"b".repeat(64)}` },
};

it("uses deterministic object ordering for build identities", () => {
  expect(buildContentKey({ b: 2, a: { d: 4, c: 3 } })).toBe(
    buildContentKey({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

it("does not include incidental project or session fields in tooling artifact identity", () => {
  expect(toolArtifactKey({ ...artifact, ...{ sessionId: "first", workspace: "/one" } })).toBe(
    toolArtifactKey({ ...artifact, ...{ sessionId: "second", workspace: "/two" } }),
  );
});

it.each([
  { version: "1.1.415" },
  { platformKey: "linux-amd64-alpine-3.23-musl" },
  { dependencyImageIds: { node: `sha256:${"c".repeat(64)}` } },
  { files: { "install.sh": "install-pyright-corrected" } },
])("invalidates tooling artifacts when build input changes: %j", (change) => {
  expect(toolArtifactKey({ ...artifact, ...change })).not.toBe(toolArtifactKey(artifact));
});

it("changes the equipped-base identity when the application base changes", () => {
  const equipped = {
    baseImageId: "base-one",
    platformKey: artifact.platformKey,
    nativeDependenciesRevision: "libraries",
    artifactImageIds: ["pyright"],
    assemblyRevision: "assembly",
    copyMode: "linked" as const,
  };
  expect(equippedBaseKey(equipped)).not.toBe(
    equippedBaseKey({ ...equipped, baseImageId: "base-two" }),
  );
});

it("changes project identity without changing the equipped-base input", () => {
  const project = { equippedImageId: "equipped", recipe: "RUN install-sdk-one", files: {} };
  expect(projectImageKey(project)).not.toBe(
    projectImageKey({ ...project, recipe: "RUN install-sdk-two" }),
  );
});

async function cacheFixture() {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-tool-cache-"));
  directories.push(directory);
  const imageId = `sha256:${"d".repeat(64)}`;
  const ports = {
    inspect: vi.fn(async () => imageId as string | undefined),
    build: vi.fn(async () => imageId),
    verify: vi.fn(async () => {}),
  };
  const key = toolArtifactKey(artifact);
  return { directory, ports, key, kind: "artifact" as const, imageId };
}

it("reuses a verified image ID without repeating installation", async () => {
  const fixture = await cacheFixture();
  expect(await ensureCachedImage(fixture)).toEqual({ imageId: fixture.imageId, reused: false });
  expect(await ensureCachedImage(fixture)).toEqual({ imageId: fixture.imageId, reused: true });
  expect(fixture.ports.build).toHaveBeenCalledTimes(1);
  expect(fixture.ports.verify).toHaveBeenCalledTimes(2);
});

it("rebuilds a cache entry whose image has been removed", async () => {
  const fixture = await cacheFixture();
  await ensureCachedImage(fixture);
  fixture.ports.inspect.mockResolvedValueOnce(undefined);
  expect(await ensureCachedImage(fixture)).toEqual({ imageId: fixture.imageId, reused: false });
  expect(fixture.ports.build).toHaveBeenCalledTimes(2);
});

it("does not publish an image whose verification failed", async () => {
  const fixture = await cacheFixture();
  fixture.ports.verify.mockRejectedValue(new Error("Missing server executable"));
  await expect(ensureCachedImage(fixture)).rejects.toThrow("Missing server executable");
  expect(
    await readPrivateText(join(fixture.directory, `artifact-${fixture.key}.json`)),
  ).toBeUndefined();
});

it("does not build after cancellation", async () => {
  const fixture = await cacheFixture();
  await expect(ensureCachedImage({ ...fixture, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(fixture.ports.build).not.toHaveBeenCalled();
});
