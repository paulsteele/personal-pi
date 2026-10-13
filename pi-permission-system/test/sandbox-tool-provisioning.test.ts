import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveEnvironmentLayers } from "../src/sandbox/environment-layers.ts";
import { defaultToolProfile, globalToolProfilePath } from "../src/sandbox/tool-profile.ts";
import { projectEnvironmentPath } from "../src/sandbox/project-environment.ts";
import {
  provisionEnvironmentImage,
  type ToolBuildPorts,
} from "../src/sandbox/tool-provisioning.ts";
import { buildContentKey } from "../src/sandbox/tool-cache.ts";
import { resolveToolPlatform } from "../src/sandbox/tool-platform.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function provisioningFixture() {
  const directory = await mkdtemp(join(tmpdir(), "tool-provisioning-"));
  directories.push(directory);
  const agentDir = join(directory, "agent");
  const project = {
    kind: "projects" as const,
    id: "a".repeat(64),
    root: join(directory, "project"),
  };
  const globalPath = globalToolProfilePath(agentDir);
  await mkdir(dirname(globalPath), { recursive: true });
  await writeFile(globalPath, JSON.stringify(defaultToolProfile()));
  const images = new Set<string>();
  const build = vi.fn<ToolBuildPorts["build"]>(async (recipe) => {
    const id = `sha256:${buildContentKey(recipe)}`;
    images.add(id);
    return id;
  });
  const ports: ToolBuildPorts = {
    build,
    inspect: async (imageId) => (images.has(imageId) ? imageId : undefined),
    validateImage: async () => {},
    resolveBuilder: async () => `sha256:${"b".repeat(64)}`,
  };
  const options = {
    baseImageId: `sha256:${"c".repeat(64)}`,
    imageUser: "node",
    platform: resolveToolPlatform({
      os: "linux",
      architecture: "arm64",
      distribution: "debian",
      release: "12",
      libc: "glibc",
    }),
    layers: await resolveEnvironmentLayers(agentDir, project),
    cacheDirectory: join(directory, "cache"),
    ports,
  };
  return { options, build, agentDir, project };
}

it("reuses all tooling artifacts across two different compatible project bases", async () => {
  const fixture = await provisioningFixture();
  const first = await provisionEnvironmentImage(fixture.options);
  expect(fixture.build).toHaveBeenCalledTimes(10);
  fixture.build.mockClear();
  const second = await provisionEnvironmentImage({
    ...fixture.options,
    baseImageId: `sha256:${"d".repeat(64)}`,
  });
  expect(fixture.build).toHaveBeenCalledTimes(1);
  expect(first.inventory.tools.map((tool) => tool.imageId)).toEqual(
    second.inventory.tools.map((tool) => tool.imageId),
  );
  expect(first.imageId).not.toBe(second.imageId);
});

it("reuses the infrastructure image and artifact mount identities for identical new sessions", async () => {
  const fixture = await provisioningFixture();
  const first = await provisionEnvironmentImage(fixture.options);
  fixture.build.mockClear();
  const second = await provisionEnvironmentImage(fixture.options);
  expect(second.imageId).toBe(first.imageId);
  expect(fixture.build).not.toHaveBeenCalled();
  expect(second.toolImageMounts).toEqual(first.toolImageMounts);
  const expectedCatalogArtifactMountCount = fixture.options.layers.tools.filter(
    (tool) => tool.catalog,
  ).length;
  expect(second.toolImageMounts).toHaveLength(expectedCatalogArtifactMountCount);
});

it("reuses the application image when a rebuilt server artifact has a new identity", async () => {
  const fixture = await provisioningFixture();
  const first = await provisionEnvironmentImage(fixture.options);
  const previousPyright = first.inventory.tools.find((tool) => tool.id === "pyright")!;
  const previousInspect = fixture.options.ports.inspect;
  const replacementId = `sha256:${"e".repeat(64)}`;
  fixture.build.mockClear();
  fixture.build.mockResolvedValueOnce(replacementId);
  fixture.options.ports.inspect = async (id, signal) => {
    if (id === replacementId) {
      return replacementId;
    }
    if (id === previousPyright.imageId) {
      return undefined;
    }
    return previousInspect(id, signal);
  };
  const second = await provisionEnvironmentImage(fixture.options);
  expect(fixture.build).toHaveBeenCalledOnce();
  expect(second.imageId).toBe(first.imageId);
  expect(second.inventory.tools.find((tool) => tool.id === "pyright")!.imageId).toBe(replacementId);
  expect(second.toolImageMounts.find((mount) => mount.toolId === "pyright")!.imageId).toBe(
    replacementId,
  );
});

it("recreates an application image without substituting saved artifact identities", async () => {
  const fixture = await provisioningFixture();
  const first = await provisionEnvironmentImage(fixture.options);
  fixture.build.mockClear();
  const second = await provisionEnvironmentImage({
    ...fixture.options,
    baseImageId: `sha256:${"d".repeat(64)}`,
    savedTools: { inventory: first.inventory, mounts: first.toolImageMounts },
  });
  expect(fixture.build).toHaveBeenCalledTimes(1);
  expect(second.imageId).not.toBe(first.imageId);
  expect(second.toolImageMounts).toEqual(first.toolImageMounts);
  expect(second.inventory.tools).toEqual(first.inventory.tools);
});

it("refuses missing saved artifacts before building replacements", async () => {
  const fixture = await provisioningFixture();
  const first = await provisionEnvironmentImage(fixture.options);
  fixture.build.mockClear();
  fixture.options.ports.inspect = async () => undefined;
  const savedTools = { inventory: first.inventory, mounts: first.toolImageMounts };
  await expect(
    provisionEnvironmentImage({
      ...fixture.options,
      savedTools,
    }),
  ).rejects.toThrow("Saved tool artifact unavailable");
  expect(fixture.build).not.toHaveBeenCalled();
});

it.each([
  { installationId: "bun", conflict: "profile tool" },
  { installationId: "pyright", conflict: "managed inventory" },
])(
  "rejects supplemental $installationId when it conflicts with $conflict",
  async ({ installationId: id }) => {
    const fixture = await provisioningFixture();
    await provisionEnvironmentImage(fixture.options);
    fixture.build.mockClear();
    if (id === "bun") {
      fixture.options.layers.tools.push({
        id,
        source: "global",
        dependencies: [],
        entry: {
          kind: "recipe",
          version: "1",
          command: ["install-bun", "1"],
          executable: "/opt/bun",
          environment: {},
          prerequisites: [],
          dependencies: [],
        },
      });
    }
    fixture.options.layers.projectEnvironment.installations.push({
      id,
      version: "2",
      command: ["install-tool", "2"],
      executable: `/opt/${id}`,
      environment: {},
      prerequisites: [],
    });
    await expect(provisionEnvironmentImage(fixture.options)).rejects.toThrow(
      "Duplicate installation ID",
    );
    expect(fixture.build).not.toHaveBeenCalled();
  },
);

it("rebuilds only the project layer when a private installation changes", async () => {
  const fixture = await provisioningFixture();
  await provisionEnvironmentImage(fixture.options);
  fixture.build.mockClear();
  const path = projectEnvironmentPath(fixture.agentDir, fixture.project);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      installations: [
        {
          id: "sdk",
          version: "1",
          command: ["install-sdk", "1"],
          executable: "/opt/sdk",
          environment: {},
          prerequisites: [],
        },
      ],
    }),
  );
  const layers = await resolveEnvironmentLayers(fixture.agentDir, fixture.project);
  const result = await provisionEnvironmentImage({ ...fixture.options, layers });
  expect(fixture.build).toHaveBeenCalledTimes(1);
  expect(fixture.build.mock.calls[0]![0].containerfile).toContain("install-sdk");
  expect(result.inventory.tools.find((tool) => tool.id === "sdk")).toMatchObject({
    source: "project",
    version: "1",
  });
});
