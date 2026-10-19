import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveProjectLocation } from "@paulsteele/pi-project-locations";
import { configPath, DEFAULT_CONFIG } from "../src/config.ts";
import { handleSandboxSetup, setupContainerBase } from "../src/sandbox/setup-command.ts";
import { setupEnvironmentLayer } from "../src/sandbox/layer-setup.ts";
import {
  globalDefinitionPath,
  projectDefinitionPath,
  selectDefinition,
} from "../src/sandbox/definition.ts";
import { projectEnvironmentPath } from "../src/sandbox/project-environment.ts";
import { loadSandboxSettings } from "../src/sandbox/settings.ts";
import { readPrivateText } from "../src/sandbox/storage.ts";
import { editConfigDraft } from "@paulsteele/pi-shared-ui";

vi.mock("@paulsteele/pi-shared-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paulsteele/pi-shared-ui")>()),
  editConfigDraft: vi.fn(),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
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
    cwd,
    hasUI: true,
    waitForIdle: async () => {},
    ui: {
      confirm: vi.fn(async () => true),
      notify: vi.fn(),
      select: vi.fn(),
    },
  };
  return { agentDir, root, cwd, project, ctx };
}

it.each(["base", "global"])(
  "%s preserves legacy settings when migration is declined",
  async (command) => {
    const fixture = await setupFixture();
    const path = configPath(fixture.agentDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(DEFAULT_CONFIG));
    fixture.ctx.ui.confirm.mockResolvedValue(false);
    await expect(handleSandboxSetup(command, fixture.ctx as never)).rejects.toThrow(
      "migration cancelled",
    );
    expect(JSON.parse((await readPrivateText(path))!.text)).toEqual(DEFAULT_CONFIG);
    expect(fixture.ctx.ui.confirm).toHaveBeenCalledOnce();
  },
);

it.each(["base", "global"])(
  "%s opens its manual editor after approved migration",
  async (command) => {
    const fixture = await setupFixture();
    const path = configPath(fixture.agentDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(DEFAULT_CONFIG));
    vi.mocked(editConfigDraft).mockResolvedValue(undefined);
    await handleSandboxSetup(command, fixture.ctx as never);
    const settings = await loadSandboxSettings(fixture.agentDir);
    expect(settings.needsMigration).toBe(false);
    expect(settings.settings.permission).toEqual(DEFAULT_CONFIG.permission);
    expect(settings.settings.sandbox).not.toHaveProperty("modelAssistedSetup");
    expect(editConfigDraft).toHaveBeenCalledOnce();
    expect(fixture.ctx.ui.select).not.toHaveBeenCalled();
    expect(fixture.ctx.ui.confirm).toHaveBeenCalledOnce();
  },
);

it.each(["model on", "model off"])("rejects the retired %s toggle command", async (command) => {
  const fixture = await setupFixture();
  await expect(handleSandboxSetup(command, fixture.ctx as never)).rejects.toThrow(
    "Use /sandbox setup [global|global tools|tools|base|update]",
  );
  expect(await readPrivateText(configPath(fixture.agentDir))).toBeUndefined();
});

it.each(["global", "project"] as const)(
  "edits the %s base without a model call and confirms before publication",
  async (scope) => {
    const fixture = await setupFixture();
    const streamSimple = vi.fn();
    const signal = new AbortController().signal;
    const ctx = {
      ...fixture.ctx,
      signal,
      modelRegistry: { streamSimple },
    };
    const project = await resolveProjectLocation(fixture.cwd);
    const target =
      scope === "global"
        ? globalDefinitionPath(fixture.agentDir)
        : projectDefinitionPath(fixture.agentDir, project);
    const draft = {
      definition: { image: "debian:trixie" },
      files: {},
      explanation: "Operator base",
    };
    vi.mocked(editConfigDraft).mockImplementationOnce(async () => {
      expect(await readPrivateText(target)).toBeUndefined();
      return JSON.stringify(draft);
    });
    ctx.ui.confirm.mockImplementationOnce(async () => {
      expect(await readPrivateText(target)).toBeUndefined();
      return true;
    });
    await setupContainerBase({
      agentDir: fixture.agentDir,
      ctx: ctx as never,
      scope,
    });
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(streamSimple).not.toHaveBeenCalled();
    expect(editConfigDraft).toHaveBeenCalledWith(
      ctx,
      `Edit devcontainer setup\n${target}`,
      JSON.stringify(
        {
          definition: { build: { dockerfile: "Containerfile" } },
          files: {
            Containerfile:
              "FROM docker.io/library/node:24-bookworm\nRUN apt-get update && apt-get install -y --no-install-recommends bash git ripgrep python3 ca-certificates\n",
          },
          explanation: "Base development environment",
        },
        null,
        2,
      ),
      signal,
    );
    expect(ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(JSON.parse((await readPrivateText(target))!.text)).toEqual(draft.definition);
  },
);

it("cancelled manual base editing leaves the definition untouched", async () => {
  const fixture = await setupFixture();
  vi.mocked(editConfigDraft).mockResolvedValue(undefined);
  await setupContainerBase({
    agentDir: fixture.agentDir,
    ctx: fixture.ctx as never,
    scope: "global",
  });
  expect(fixture.ctx.ui.confirm).not.toHaveBeenCalled();
  expect(await readPrivateText(globalDefinitionPath(fixture.agentDir))).toBeUndefined();
});

it("writes the first descendant supplement under the private parent base identity", async () => {
  const fixture = await setupFixture();
  const basePath = projectDefinitionPath(fixture.agentDir, fixture.project);
  await mkdir(dirname(basePath), { recursive: true });
  await writeFile(basePath, '{"image":"debian"}');
  vi.mocked(editConfigDraft).mockResolvedValue('{"version":1}');
  await setupEnvironmentLayer({
    agentDir: fixture.agentDir,
    ctx: fixture.ctx as never,
    kind: "project-environment",
  });
  expect(
    await readPrivateText(projectEnvironmentPath(fixture.agentDir, fixture.project)),
  ).toBeDefined();
  expect((await selectDefinition({ cwd: fixture.cwd, agentDir: fixture.agentDir })).path).toBe(
    basePath,
  );
});

it("creates a descendant-requested base under the existing parent supplement identity", async () => {
  const fixture = await setupFixture();
  const environmentPath = projectEnvironmentPath(fixture.agentDir, fixture.project);
  await mkdir(dirname(environmentPath), { recursive: true });
  await writeFile(environmentPath, '{"version":1}');
  vi.mocked(editConfigDraft).mockResolvedValue(
    JSON.stringify({ definition: { image: "debian" }, files: {}, explanation: "Operator base" }),
  );
  await handleSandboxSetup("base", fixture.ctx as never);
  const basePath = projectDefinitionPath(fixture.agentDir, fixture.project);
  expect(JSON.parse((await readPrivateText(basePath))!.text)).toEqual({ image: "debian" });
  expect((await selectDefinition({ cwd: fixture.cwd, agentDir: fixture.agentDir })).path).toBe(
    basePath,
  );
  expect(JSON.parse((await readPrivateText(environmentPath))!.text)).toEqual({ version: 1 });
});
