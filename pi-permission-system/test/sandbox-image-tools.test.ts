import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  imageToolsDefinition,
  planImageTools,
  type ImageToolInstallation,
} from "../src/sandbox/image-tools.ts";
import type { SandboxSession } from "../src/sandbox/session.ts";
import type { ResolvedDefinition } from "../src/sandbox/definition.ts";
import { readPrivateText } from "../src/sandbox/storage.ts";

const ports = vi.hoisted(() => ({ resolve: vi.fn(), podman: vi.fn() }));
vi.mock("../src/sandbox/definition.ts", async (original) => ({
  ...(await original()),
  resolveDefinition: ports.resolve,
}));
vi.mock("../src/sandbox/driver.ts", () => ({ podmanOutput: ports.podman }));
const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});
const pyright: ImageToolInstallation = {
  id: "pyright",
  version: "1.1.414",
  command: ["npm", "install", "--prefix", "/opt/pyright", "pyright@1.1.414"],
  environment: {},
  executable: "/opt/pyright/node_modules/.bin/pyright-langserver",
  prerequisites: ["node", "npm"],
};

it("turns an image definition into a pinned tool build while preserving hooks, mounts, and runtime user", () => {
  const result = imageToolsDefinition({
    definition: {
      image: "node:24-bookworm",
      remoteUser: "node",
      postCreateCommand: ["npm", "ci"],
      forwardPorts: [3000],
      mounts: ["type=bind,source=/data,target=/data"],
    },
    imageUser: "node",
    installations: [pyright],
    recipePath: "Containerfile.quality",
  });
  expect(result.definition).toMatchObject({
    build: { dockerfile: "Containerfile.quality", context: "." },
    remoteUser: "node",
    postCreateCommand: ["npm", "ci"],
    forwardPorts: [3000],
    mounts: ["type=bind,source=/data,target=/data"],
  });
  expect(result.definition.image).toBeUndefined();
  expect(result.recipe).toContain("FROM node:24-bookworm\nUSER root\n");
  expect(result.recipe).toContain("Missing image prerequisite: node for pyright");
  expect(result.recipe).toContain("pyright@1.1.414");
  expect(result.recipe).toMatch(/USER node\n$/);
});

it("extends the selected build target without changing build context or arguments", () => {
  const recipe = "FROM node:24-bookworm AS development\nCOPY app /app\nFROM scratch AS release\n";
  const result = imageToolsDefinition({
    definition: {
      build: {
        dockerfile: "Dockerfile",
        context: "..",
        target: "development",
        args: { MODE: "dev" },
        cacheFrom: "cached",
      },
    },
    baseRecipe: recipe,
    buildContext: "/repo",
    imageUser: "1000:1000",
    installations: [pyright],
    recipePath: "Containerfile.quality",
  });
  expect(result.recipe).toContain(
    `${recipe.trimEnd()}\nFROM development AS pi_sandbox_tools\nUSER root`,
  );
  expect(result.recipe).toMatch(/USER 1000:1000\n$/);
  expect(result.definition.build).toEqual({
    dockerfile: "Containerfile.quality",
    context: "/repo",
    args: { MODE: "dev" },
    cacheFrom: "cached",
  });
});

it("quotes install arguments and environment values rather than interpreting them as shell commands", () => {
  const result = imageToolsDefinition({
    definition: { image: "debian" },
    imageUser: "root",
    recipePath: "Containerfile.quality",
    installations: [
      {
        ...pyright,
        command: ["installer", "name'; touch /tmp/unexpected"],
        environment: { MODE: "$(touch /tmp/unexpected)" },
      },
    ],
  });
  const run = JSON.parse(
    result.recipe
      .split("\n")
      .find((line) => line.startsWith("RUN "))!
      .slice(4),
  );
  expect(run[2]).toContain("MODE='$(touch /tmp/unexpected)'");
  expect(run[2]).toContain("'name'\\''; touch /tmp/unexpected'");
});

async function proposalFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "image-tools-")));
  directories.push(directory);
  const path = join(directory, "global/devcontainer.json");
  await mkdir(dirname(path));
  const sourceText = '{"image":"node:24-bookworm"}\n';
  await writeFile(path, sourceText);
  const resolved: ResolvedDefinition = {
    path,
    sourceText,
    revision: "original",
    definition: { image: "node:24-bookworm" },
    tier: "global",
    startupDirectory: "/workspace",
    project: { id: "a".repeat(64), kind: "projects", root: "/workspace" },
  };
  const rebuild = vi.fn(async () => {});
  const session = {
    options: { resolved, hostEnvironment: [] },
    revision: "authority",
    environment: { image: "sha256:image" },
    rebuildFromDefinition: rebuild,
  } as unknown as SandboxSession;
  ports.resolve.mockResolvedValue(resolved);
  ports.podman.mockResolvedValue(
    JSON.stringify([{ Id: "sha256:image", Config: { User: "node" } }]),
  );
  return { session, resolved, path, rebuild, sourceText, signal: new AbortController().signal };
}

it("only writes the active definition and generated recipe when the proposal is applied", async () => {
  const fixture = await proposalFixture();
  const proposal = await planImageTools(fixture.session, [pyright], fixture.signal);
  expect(proposal?.preview).toContain(fixture.path);
  expect(proposal?.preview).toContain("global definition also affects future projects");
  expect((await readPrivateText(fixture.path))!.text).toBe(fixture.sourceText);
  expect(fixture.rebuild).not.toHaveBeenCalled();
  const replacement = { ...fixture.resolved, revision: "replacement" };
  ports.resolve.mockResolvedValueOnce(fixture.resolved).mockResolvedValueOnce(replacement);
  await proposal!.apply(fixture.signal);
  const published = JSON.parse((await readPrivateText(fixture.path))!.text);
  expect(published.build.dockerfile).toMatch(/^Containerfile\.tools-/);
  expect(
    (await readPrivateText(join(dirname(fixture.path), published.build.dockerfile)))!.text,
  ).toContain("pyright@1.1.414");
  expect(fixture.rebuild).toHaveBeenCalledExactlyOnceWith(replacement, fixture.signal);
});

it("does not regenerate a recipe when its tool receipts already match", async () => {
  const fixture = await proposalFixture();
  fixture.resolved.definition = imageToolsDefinition({
    definition: fixture.resolved.definition,
    imageUser: "node",
    installations: [pyright],
    recipePath: "recipe",
  }).definition;
  expect(await planImageTools(fixture.session, [pyright], fixture.signal)).toBeUndefined();
  expect(ports.podman).not.toHaveBeenCalled();
});

it("preserves source substitutions and relative build context when updating a global JSONC definition", async () => {
  const fixture = await proposalFixture();
  const sourceText =
    '{\n// reusable default\n"image":"node:24-bookworm",\n"workspaceFolder":"${localWorkspaceFolder}",\n"remoteEnv":{"PROJECT":"${localWorkspaceFolder}"},\n}\n';
  fixture.resolved.sourceText = sourceText;
  fixture.resolved.definition.workspaceFolder = "/workspace";
  fixture.resolved.definition.remoteEnv = { PROJECT: "/workspace" };
  await writeFile(fixture.path, sourceText);
  const proposal = await planImageTools(fixture.session, [pyright], fixture.signal);
  expect(proposal!.preview).toContain("${localWorkspaceFolder}");
  await proposal!.apply(fixture.signal);
  const published = JSON.parse((await readPrivateText(fixture.path))!.text);
  expect(published.workspaceFolder).toBe("${localWorkspaceFolder}");
  expect(published.remoteEnv.PROJECT).toBe("${localWorkspaceFolder}");
});

it("restores the previous definition when the approved rebuild fails", async () => {
  const fixture = await proposalFixture();
  const proposal = await planImageTools(fixture.session, [pyright], fixture.signal);
  fixture.rebuild.mockRejectedValue(new Error("Image build failed"));
  await expect(proposal!.apply(fixture.signal)).rejects.toThrow("Image build failed");
  expect((await readPrivateText(fixture.path))!.text).toBe(fixture.sourceText);
});

it("refuses a stale or cancelled image proposal before publishing", async () => {
  const fixture = await proposalFixture();
  const proposal = await planImageTools(fixture.session, [pyright], fixture.signal);
  await expect(proposal!.apply(AbortSignal.abort())).rejects.toThrow();
  ports.resolve.mockResolvedValue({ ...fixture.resolved, revision: "changed" });
  await expect(proposal!.apply(fixture.signal)).rejects.toThrow(
    "changed since image-tool proposal",
  );
  expect((await readPrivateText(fixture.path))!.text).toBe(fixture.sourceText);
  expect(fixture.rebuild).not.toHaveBeenCalled();
});
