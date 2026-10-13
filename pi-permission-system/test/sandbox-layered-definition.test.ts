import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  globalDefinitionPath,
  resolveDefinition,
  selectDefinition,
} from "../src/sandbox/definition.ts";
import {
  defaultToolProfile,
  globalToolProfilePath,
  projectToolProfilePath,
} from "../src/sandbox/tool-profile.ts";
import {
  configuredEnvironmentSourcePaths,
  validateEnvironmentSources,
} from "../src/sandbox/environment-layers.ts";
import { projectEnvironmentPath } from "../src/sandbox/project-environment.ts";
import { readPrivateText } from "../src/sandbox/storage.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function definitionFixture() {
  const directory = await mkdtemp(join(tmpdir(), "layered-definition-"));
  directories.push(directory);
  const cwd = join(directory, "workspace");
  const agentDir = join(directory, "agent");
  await mkdir(cwd);
  const base = globalDefinitionPath(agentDir);
  await mkdir(dirname(base), { recursive: true });
  await writeFile(base, '{"image":"node:24-bookworm"}');
  await writeFile(globalToolProfilePath(agentDir), JSON.stringify(defaultToolProfile()));
  const selected = await selectDefinition({ cwd, agentDir });
  const readBaseConfiguration = async () =>
    JSON.stringify({ configuration: { image: "node:24-bookworm" } });
  return { cwd, agentDir, base, selected, readConfiguration: readBaseConfiguration };
}

it.each([
  {
    scenario: "global tools only",
    configuredFiles: [],
    expectedConfiguredPaths: [],
  },
  {
    scenario: "global and project tools",
    configuredFiles: ["tools"],
    expectedConfiguredPaths: ["tools"],
  },
  {
    scenario: "global tools and project environment",
    configuredFiles: ["environment"],
    expectedConfiguredPaths: ["environment"],
  },
  {
    scenario: "all three configurations",
    configuredFiles: ["tools", "environment"],
    expectedConfiguredPaths: ["tools", "environment"],
  },
] as const)("presents only configured source paths with $scenario", async (configuration) => {
  const fixture = await definitionFixture();
  const toolsPath = projectToolProfilePath(fixture.agentDir, fixture.selected.project);
  const environmentPath = projectEnvironmentPath(fixture.agentDir, fixture.selected.project);
  const paths = { tools: toolsPath, environment: environmentPath };
  const contents = {
    tools: { version: 1, tools: {} },
    environment: { version: 1, remoteEnv: { PROJECT: "private" } },
  };
  for (const file of configuration.configuredFiles) {
    const path = paths[file];
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(contents[file]));
  }
  const resolved = await resolveDefinition(fixture);
  expect(configuredEnvironmentSourcePaths(resolved.layers)).toEqual([
    globalToolProfilePath(fixture.agentDir),
    ...configuration.expectedConfiguredPaths.map((file) => paths[file]),
  ]);
  expect(resolved.layers?.sources.map((source) => source.path)).toEqual([
    globalToolProfilePath(fixture.agentDir),
    toolsPath,
    environmentPath,
  ]);
});

it("leaves tooling source paths unspecified for a legacy definition", () => {
  expect(configuredEnvironmentSourcePaths(undefined)).toBeUndefined();
});

it("still detects a newly created config that was omitted from presentation", async () => {
  const fixture = await definitionFixture();
  const resolved = await resolveDefinition(fixture);
  expect(configuredEnvironmentSourcePaths(resolved.layers)).toEqual([
    globalToolProfilePath(fixture.agentDir),
  ]);
  const toolsPath = projectToolProfilePath(fixture.agentDir, fixture.selected.project);
  await mkdir(dirname(toolsPath), { recursive: true });
  await writeFile(toolsPath, JSON.stringify({ version: 1, tools: {} }));
  await expect(validateEnvironmentSources(resolved.layers!)).rejects.toThrow(
    `Environment source changed during provisioning: ${toolsPath}`,
  );
});

it("extends a fallback with private project settings without writing the fallback", async () => {
  const fixture = await definitionFixture();
  const path = projectEnvironmentPath(fixture.agentDir, fixture.selected.project);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      remoteEnv: { PROJECT: "private" },
      postCreateCommand: ["project-setup"],
    }),
  );
  const resolved = await resolveDefinition(fixture);
  expect(resolved.definition.remoteEnv).toEqual({ PROJECT: "private" });
  expect(resolved.definition.postCreateCommand).toEqual(["project-setup"]);
  expect(resolved.layers?.tools).toHaveLength(9);
  expect((await readPrivateText(fixture.base))?.text).toBe('{"image":"node:24-bookworm"}');
});

it("changes only the composed revision when a private project supplement changes", async () => {
  const fixture = await definitionFixture();
  const first = await resolveDefinition(fixture);
  const path = projectEnvironmentPath(fixture.agentDir, fixture.selected.project);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, remoteEnv: { PROJECT: "changed" } }));
  const second = await resolveDefinition(fixture);
  expect(second.baseRevision).toBe(first.baseRevision);
  expect(second.revision).not.toBe(first.revision);
});

it("substitutes workspace values in private settings without corrupting JSON quotes", async () => {
  const fixture = await definitionFixture();
  const path = projectEnvironmentPath(fixture.agentDir, fixture.selected.project);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ version: 1, remoteEnv: { ROOT: "${localWorkspaceFolder}" } }),
  );
  const resolved = await resolveDefinition({
    ...fixture,
    selected: { ...fixture.selected, startupDirectory: '/workspace/"quoted"' },
  });
  expect(resolved.definition.remoteEnv?.ROOT).toBe('/workspace/"quoted"');
});
