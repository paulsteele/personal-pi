import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveProjectLocation } from "@paulsteele/pi-project-locations";
import {
  discoverLocalDefinitions,
  globalDefinitionPath,
  projectDefinitionPath,
  resolveDefinition,
  selectDefinition,
  devcontainerDefinitionSchema,
  validateHostEnvironmentImports,
} from "../src/sandbox/definition.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
  directories.length = 0;
});
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sandbox-definition-")));
  directories.push(directory);
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  return { cwd, agentDir };
}
async function definitionFile(
  path: string,
  text = '{"image":"docker.io/library/debian:bookworm"}',
) {
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

it("uses private project, then local, then global definitions", async () => {
  const { cwd, agentDir } = await fixture();
  const global = globalDefinitionPath(agentDir);
  await definitionFile(global);
  expect((await selectDefinition({ cwd, agentDir })).tier).toBe("global");
  const local = join(cwd, ".devcontainer", "devcontainer.json");
  await definitionFile(local);
  expect((await selectDefinition({ cwd, agentDir })).path).toBe(local);
  const project = await resolveProjectLocation(cwd);
  const privatePath = projectDefinitionPath(agentDir, project);
  await definitionFile(privatePath);
  expect((await selectDefinition({ cwd, agentDir })).path).toBe(privatePath);
});

it("uses spec local discovery order and requires selection for named definitions", async () => {
  const { cwd } = await fixture();
  const first = join(cwd, ".devcontainer", "a", "devcontainer.json");
  const second = join(cwd, ".devcontainer", "b", "devcontainer.json");
  await definitionFile(second);
  await definitionFile(first);
  expect(await discoverLocalDefinitions(cwd)).toEqual([first, second]);
  const alternate = join(cwd, ".devcontainer.json");
  await definitionFile(alternate);
  expect(await discoverLocalDefinitions(cwd)).toEqual([alternate]);
  const primary = join(cwd, ".devcontainer", "devcontainer.json");
  await definitionFile(primary);
  expect(await discoverLocalDefinitions(cwd)).toEqual([primary]);
});

it("does not silently fall back when multiple local definitions require a decision", async () => {
  const { cwd, agentDir } = await fixture();
  const selected = join(cwd, ".devcontainer", "node", "devcontainer.json");
  await definitionFile(selected);
  await definitionFile(join(cwd, ".devcontainer", "python", "devcontainer.json"));
  await expect(selectDefinition({ cwd, agentDir })).rejects.toThrow("Choose a devcontainer");
  expect((await selectDefinition({ cwd, agentDir, choose: async () => selected })).path).toBe(
    selected,
  );
});

it("resolves JSONC and substitutions through the pinned reference CLI without running initialization", async () => {
  const { cwd, agentDir } = await fixture();
  const path = globalDefinitionPath(agentDir);
  await definitionFile(
    path,
    `{
    // Global development environment
    "image": "docker.io/library/debian:bookworm",
    "workspaceFolder": "\${localWorkspaceFolder}",
    "initializeCommand": "exit 99",
  }`,
  );
  const resolved = await resolveDefinition({ selected: await selectDefinition({ cwd, agentDir }) });
  expect(resolved.definition.workspaceFolder).toBe(cwd);
  expect(resolved.definition.initializeCommand).toBe("exit 99");
  expect(resolved.definition.image).toBe("docker.io/library/debian:bookworm");
});

it("resolves a Containerfile and build context relative to the selected definition", async () => {
  const { cwd, agentDir } = await fixture();
  const path = join(cwd, ".devcontainer", "devcontainer.json");
  await definitionFile(path, '{"build":{"dockerfile":"Containerfile","context":".."}}');
  await writeFile(join(cwd, ".devcontainer", "Containerfile"), "FROM debian:bookworm\n");
  const resolved = await resolveDefinition({ selected: await selectDefinition({ cwd, agentDir }) });
  expect(resolved.containerfile).toBe(join(cwd, ".devcontainer", "Containerfile"));
  expect(resolved.buildContext).toBe(cwd);
});

it("checks actual private agent storage even when resolving a base without environment layers", async () => {
  const { cwd } = await fixture();
  const agentDir = join(cwd, ".private-agent");
  await mkdir(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const path = join(cwd, ".devcontainer", "devcontainer.json");
  await definitionFile(path, '{"build":{"dockerfile":"Containerfile","context":".."}}');
  await writeFile(join(cwd, ".devcontainer", "Containerfile"), "FROM debian:bookworm\n");
  const selected = await selectDefinition({ cwd, agentDir });
  await expect(resolveDefinition({ selected })).rejects.toThrow("exposes private sandbox authority");
});

it.each([
  { features: { "ghcr.io/devcontainers/features/node:1": {} }, image: "debian" },
  { dockerComposeFile: "compose.yaml", service: "app" },
  { image: "debian", privileged: true },
  { image: "debian", runArgs: ["--network=host"] },
  { image: "debian", build: { dockerfile: "Containerfile" } },
])("rejects unsupported or unsafe devcontainer definition %j", (value) => {
  expect(() => devcontainerDefinitionSchema.parse(value)).toThrow();
});

it("requires explicit approval for host environment imports", () => {
  expect(() =>
    validateHostEnvironmentImports('{"containerEnv":{"TOKEN":"${localEnv:HOME}"}}', []),
  ).toThrow("approved variable");
  expect(() =>
    validateHostEnvironmentImports('{"containerEnv":{"HOME":"${localEnv:HOME}"}}', ["HOME"]),
  ).not.toThrow();
});
