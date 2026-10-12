import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveProjectLocation } from "@paulsteele/pi-project-locations";
import { configPath, DEFAULT_CONFIG } from "../src/config.ts";
import { handleSandboxSetup } from "../src/sandbox/setup-command.ts";
import { setupEnvironmentLayer } from "../src/sandbox/layer-setup.ts";
import { projectDefinitionPath, selectDefinition } from "../src/sandbox/definition.ts";
import { projectEnvironmentPath } from "../src/sandbox/project-environment.ts";
import { loadSandboxSettings } from "../src/sandbox/settings.ts";
import { readPrivateText } from "../src/sandbox/storage.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setupFixture() {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-setup-command-"));
  directories.push(directory);
  const agentDir = join(directory, "agent");
  const root = join(directory, "project");
  const cwd = join(root, "child");
  await mkdir(cwd, { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const project = await resolveProjectLocation(root);
  const ctx = {
    cwd, hasUI: true, waitForIdle: async () => {},
    ui: { confirm: vi.fn(async () => true), notify: vi.fn(), select: vi.fn(async () => "Edit manually"), editor: vi.fn() },
  };
  return { agentDir, root, cwd, project, ctx };
}

it.each(["model on", "model off"])("%s preserves legacy settings when migration is declined", async (command) => {
  const fixture = await setupFixture();
  const path = configPath(fixture.agentDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(DEFAULT_CONFIG));
  fixture.ctx.ui.confirm.mockResolvedValue(false);
  await expect(handleSandboxSetup(command, fixture.ctx as never)).rejects.toThrow("migration cancelled");
  expect(JSON.parse((await readPrivateText(path))!.text)).toEqual(DEFAULT_CONFIG);
  expect(fixture.ctx.ui.confirm).toHaveBeenCalledOnce();
});

it.each(["model on", "model off"])("%s applies its toggle only after approved migration", async (command) => {
  const fixture = await setupFixture();
  const path = configPath(fixture.agentDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(DEFAULT_CONFIG));
  await handleSandboxSetup(command, fixture.ctx as never);
  const settings = await loadSandboxSettings(fixture.agentDir);
  expect(settings.needsMigration).toBe(false);
  expect(settings.settings.permission).toEqual(DEFAULT_CONFIG.permission);
  expect(settings.settings.sandbox.modelAssistedSetup).toBe(command === "model on");
  expect(fixture.ctx.ui.confirm).toHaveBeenCalledOnce();
});

it("writes the first descendant supplement under the private parent base identity", async () => {
  const fixture = await setupFixture();
  const basePath = projectDefinitionPath(fixture.agentDir, fixture.project);
  await mkdir(dirname(basePath), { recursive: true });
  await writeFile(basePath, '{"image":"debian"}');
  fixture.ctx.ui.editor.mockResolvedValue('{"version":1}');
  await setupEnvironmentLayer({ agentDir: fixture.agentDir, ctx: fixture.ctx as never, kind: "project-environment" });
  expect(await readPrivateText(projectEnvironmentPath(fixture.agentDir, fixture.project))).toBeDefined();
  expect((await selectDefinition({ cwd: fixture.cwd, agentDir: fixture.agentDir })).path).toBe(basePath);
});

it("creates a descendant-requested base under the existing parent supplement identity", async () => {
  const fixture = await setupFixture();
  const environmentPath = projectEnvironmentPath(fixture.agentDir, fixture.project);
  await mkdir(dirname(environmentPath), { recursive: true });
  await writeFile(environmentPath, '{"version":1}');
  fixture.ctx.ui.editor.mockResolvedValue(JSON.stringify({ definition: { image: "debian" }, files: {}, explanation: "Operator base" }));
  await handleSandboxSetup("base", fixture.ctx as never);
  const basePath = projectDefinitionPath(fixture.agentDir, fixture.project);
  expect(JSON.parse((await readPrivateText(basePath))!.text)).toEqual({ image: "debian" });
  expect((await selectDefinition({ cwd: fixture.cwd, agentDir: fixture.agentDir })).path).toBe(basePath);
  expect(JSON.parse((await readPrivateText(environmentPath))!.text)).toEqual({ version: 1 });
});
