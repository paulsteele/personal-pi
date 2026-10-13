import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { planProfileToolInstallation } from "../src/sandbox/profile-tool-installation.ts";
import { resolveEnvironmentLayers } from "../src/sandbox/environment-layers.ts";
import {
  defaultToolProfile,
  globalToolProfilePath,
  projectToolProfilePath,
} from "../src/sandbox/tool-profile.ts";
import { readPrivateText } from "../src/sandbox/storage.ts";
import type { SandboxSession } from "../src/sandbox/session.ts";
import type { ResolvedDefinition } from "../src/sandbox/definition.ts";

const ports = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../src/sandbox/definition.ts", async (original) => ({
  ...(await original()),
  resolveDefinition: ports.resolve,
}));
const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function installationFixture() {
  const directory = await mkdtemp(join(tmpdir(), "private-tool-install-"));
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
  const layers = await resolveEnvironmentLayers(agentDir, project);
  const resolved: ResolvedDefinition = {
    path: join(directory, "devcontainer.json"),
    project,
    startupDirectory: project.root,
    tier: "global",
    definition: { image: "node" },
    sourceText: '{"image":"node"}',
    revision: "current",
    baseRevision: "base",
    layers,
  };
  const rebuild = vi.fn<SandboxSession["rebuildFromDefinition"]>();
  const session = {
    directory,
    revision: "authority",
    options: { agentDir, resolved, hostEnvironment: [] },
    rebuildFromDefinition: rebuild,
  } as unknown as SandboxSession;
  ports.resolve.mockResolvedValue(resolved);
  const installation = {
    id: "custom",
    version: "1",
    executable: "/opt/custom/bin/tool",
    command: ["install-custom", "1"],
    prerequisites: [],
    environment: {},
  };
  return {
    session,
    rebuild,
    resolved,
    installation,
    path: projectToolProfilePath(agentDir, project),
    globalPath,
    directory,
  };
}

it("keeps the project tool file unpublished while the candidate image builds", async () => {
  const fixture = await installationFixture();
  fixture.rebuild.mockImplementation(async (_replacement, _signal, publication) => {
    expect(await readPrivateText(fixture.path)).toBeUndefined();
    await publication!.commit();
    expect((await readPrivateText(fixture.path))?.text).toContain("install-custom");
  });
  const proposal = await planProfileToolInstallation(
    fixture.session,
    [fixture.installation],
    new AbortController().signal,
  );
  expect(await readPrivateText(fixture.path)).toBeUndefined();
  await proposal!.apply(new AbortController().signal);
  expect(
    await readPrivateText(join(fixture.directory, "tool-profile-transaction.json")),
  ).toBeUndefined();
});

it("leaves no project tool file after a candidate build failure", async () => {
  const fixture = await installationFixture();
  fixture.rebuild.mockRejectedValue(new Error("Candidate image failed"));
  const proposal = await planProfileToolInstallation(
    fixture.session,
    [fixture.installation],
    new AbortController().signal,
  );
  await expect(proposal!.apply(new AbortController().signal)).rejects.toThrow(
    "Candidate image failed",
  );
  expect(await readPrivateText(fixture.path)).toBeUndefined();
});

it.each(["global", "project"] as const)(
  "builds a %s tool recipe before publishing only that profile",
  async (scope) => {
    const fixture = await installationFixture();
    const signal = new AbortController().signal;
    const targetPath = scope === "global" ? fixture.globalPath : fixture.path;
    const otherPath = scope === "global" ? fixture.path : fixture.globalPath;
    const previousTarget = await readPrivateText(targetPath);
    const previousOther = await readPrivateText(otherPath);
    fixture.rebuild.mockImplementation(async (replacement, rebuildSignal, publication) => {
      expect(rebuildSignal).toBe(signal);
      expect(await readPrivateText(targetPath)).toEqual(previousTarget);
      expect(await readPrivateText(otherPath)).toEqual(previousOther);
      expect(replacement.path).toBe(fixture.resolved.path);
      expect(replacement.definition).toEqual(fixture.resolved.definition);
      expect(replacement.layers!.tools.find((tool) => tool.id === "custom")).toMatchObject({
        source: scope,
        entry: { kind: "recipe", command: ["install-custom", "1"] },
      });
      const candidateProfile =
        scope === "global" ? replacement.layers!.globalTools : replacement.layers!.projectTools;
      expect(candidateProfile!.path).toBe(targetPath);
      await publication!.commit();
    });
    const proposal = await planProfileToolInstallation(
      fixture.session,
      [fixture.installation],
      signal,
      scope,
    );
    expect(proposal!.preview).toContain(`Save private ${scope} tools: ${targetPath}`);
    if (scope === "global") {
      expect(proposal!.preview).toContain("future builds in other projects");
    }
    await proposal!.apply(signal);
    expect(JSON.parse((await readPrivateText(targetPath))!.text).tools.custom).toMatchObject({
      kind: "recipe",
      version: "1",
      command: ["install-custom", "1"],
    });
    expect(await readPrivateText(otherPath)).toEqual(previousOther);
  },
);

it.each(["build", "session persistence"])(
  "retains the global tool profile after a %s failure",
  async (failureStage) => {
    const fixture = await installationFixture();
    const previous = await readPrivateText(fixture.globalPath);
    fixture.rebuild.mockImplementation(async (_replacement, _signal, publication) => {
      if (failureStage === "session persistence") {
        await publication!.commit();
        await publication!.rollback();
      }
      throw new Error(`${failureStage} failed`);
    });
    const signal = new AbortController().signal;
    const proposal = await planProfileToolInstallation(
      fixture.session,
      [fixture.installation],
      signal,
      "global",
    );
    await expect(proposal!.apply(signal)).rejects.toThrow(`${failureStage} failed`);
    expect(await readPrivateText(fixture.globalPath)).toEqual(previous);
    expect(await readPrivateText(fixture.path)).toBeUndefined();
    expect(
      await readPrivateText(join(fixture.directory, "tool-profile-transaction.json")),
    ).toBeUndefined();
  },
);

it("rejects global installation when a project recipe would override it", async () => {
  const fixture = await installationFixture();
  await mkdir(dirname(fixture.path), { recursive: true });
  await writeFile(
    fixture.path,
    JSON.stringify({
      version: 1,
      tools: {
        custom: { kind: "recipe", ...fixture.installation, id: undefined, version: "2" },
      },
      exclude: [],
    }),
  );
  fixture.resolved.layers = await resolveEnvironmentLayers(
    fixture.session.options.agentDir,
    fixture.resolved.project,
  );
  const previous = await readPrivateText(fixture.globalPath);
  await expect(
    planProfileToolInstallation(
      fixture.session,
      [fixture.installation],
      new AbortController().signal,
      "global",
    ),
  ).rejects.toThrow("Project tools override or exclude custom");
  expect(fixture.rebuild).not.toHaveBeenCalled();
  expect(await readPrivateText(fixture.globalPath)).toEqual(previous);
});

it("rejects publication if the global profile changes after its preview", async () => {
  const fixture = await installationFixture();
  const signal = new AbortController().signal;
  const proposal = await planProfileToolInstallation(
    fixture.session,
    [fixture.installation],
    signal,
    "global",
  );
  const concurrentProfile = `${JSON.stringify(defaultToolProfile(), null, 2)}\n`;
  await writeFile(fixture.globalPath, concurrentProfile);
  await expect(proposal!.apply(signal)).rejects.toThrow("Environment source changed");
  expect(fixture.rebuild).not.toHaveBeenCalled();
  expect((await readPrivateText(fixture.globalPath))!.text).toBe(concurrentProfile);
});

it("removes its own newly published file when session persistence fails", async () => {
  const fixture = await installationFixture();
  fixture.rebuild.mockImplementation(async (_replacement, _signal, publication) => {
    await publication!.commit();
    await publication!.rollback();
    throw new Error("Session persistence failed");
  });
  const proposal = await planProfileToolInstallation(
    fixture.session,
    [fixture.installation],
    new AbortController().signal,
  );
  await expect(proposal!.apply(new AbortController().signal)).rejects.toThrow(
    "Session persistence failed",
  );
  expect(await readPrivateText(fixture.path)).toBeUndefined();
});
