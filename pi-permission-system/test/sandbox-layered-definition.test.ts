import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  globalDefinitionPath,
  resolveDefinition,
  selectDefinition,
} from "../src/sandbox/definition.ts";
import { defaultToolProfile, globalToolProfilePath } from "../src/sandbox/tool-profile.ts";
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
