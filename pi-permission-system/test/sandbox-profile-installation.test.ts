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
