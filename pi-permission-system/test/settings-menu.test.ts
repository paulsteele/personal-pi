import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverSettingsSections, openSettingsSection } from "@paulsteele/pi-shared-ui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  globalDefinitionPath,
  projectDefinitionPath,
  resolveSandboxProject,
} from "../src/sandbox/definition.ts";
import {
  defaultToolProfile,
  globalToolProfilePath,
  projectToolProfilePath,
} from "../src/sandbox/tool-profile.ts";
import { projectEnvironmentPath } from "../src/sandbox/project-environment.ts";
import { registerSandboxSettings } from "../src/sandbox/settings-menu.ts";
import { hostCommandProfilePath } from "../src/sandbox/host-command-profile.ts";
import * as privateStorage from "../src/sandbox/storage.ts";
import { configPath, DEFAULT_CONFIG } from "../src/config.ts";
import { loadSandboxSettings } from "../src/sandbox/settings.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(sandboxState: "ready" | "unavailable" = "ready") {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-settings-"));
  directories.push(directory);
  const root = join(directory, "project");
  const agentDir = join(directory, "agent");
  await mkdir(root);
  const project = await resolveSandboxProject(root, agentDir);
  const subscribers = new Set<(value: unknown) => void>();
  const pi = {
    events: {
      on(_name: string, handler: (value: unknown) => void) {
        subscribers.add(handler);
        return () => subscribers.delete(handler);
      },
      emit(_name: string, value: unknown) {
        for (const subscriber of subscribers) {
          subscriber(value);
        }
      },
    },
  };
  const getSession = vi.fn(() => {
    if (sandboxState === "unavailable") {
      throw new Error("Sandbox container is not ready");
    }
    return { options: { resolved: { project } } } as never;
  });
  registerSandboxSettings(pi as never, agentDir, getSession);
  return { sections: discoverSettingsSections(pi), root, agentDir, project, getSession };
}

function settingsContextThatCapturesRenderedLines(
  rendered: string[],
  cwd: string,
): ExtensionContext {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify: vi.fn(),
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        const component = await factory(
          { terminal: { rows: 24 }, requestRender() {} } as never,
          {
            fg: (_color: string, text: string) => text,
            bg: (_color: string, text: string) => text,
          } as never,
          {} as never,
          () => {},
        );
        rendered.push(...component.render(100));
        return "back";
      },
    },
  } as unknown as ExtensionContext;
}

it("contributes settings independently of sidebar load order", async () => {
  const setup = await fixture();
  expect(setup.sections.map((section) => section.id)).toEqual([
    "sandbox",
    "host-commands",
    "sandbox-base-global",
    "sandbox-tools-global",
    "sandbox-base-project",
    "sandbox-tools-project",
    "sandbox-environment",
  ]);
});

it.each([
  {
    sectionId: "host-commands",
    profilePath: hostCommandProfilePath,
    submitted: { hostCommands: [{ executable: "dotnet" }] },
    expectedProfile: { hostCommands: [{ executable: "dotnet" }] },
  },
  {
    sectionId: "sandbox-base-project",
    profilePath: projectDefinitionPath,
    submitted: { definition: { image: "docker.io/library/debian:trixie" } },
    expectedProfile: { image: "docker.io/library/debian:trixie" },
  },
  {
    sectionId: "sandbox-tools-project",
    profilePath: projectToolProfilePath,
    submitted: {
      version: 1,
      tools: {
        bun: {
          kind: "recipe",
          version: "1.3.10",
          command: ["install-bun", "1.3.10"],
          environment: {},
          executable: "/usr/local/bin/bun",
          prerequisites: ["sh"],
        },
      },
      exclude: [],
    },
    expectedProfile: {
      version: 1,
      tools: {
        bun: {
          kind: "recipe",
          version: "1.3.10",
          command: ["install-bun", "1.3.10"],
          environment: {},
          executable: "/usr/local/bin/bun",
          prerequisites: ["sh"],
        },
      },
      exclude: [],
    },
  },
  {
    sectionId: "sandbox-environment",
    profilePath: projectEnvironmentPath,
    submitted: { version: 1, containerEnv: { PROJECT_MODE: "development" } },
    expectedProfile: { version: 1, containerEnv: { PROJECT_MODE: "development" } },
  },
])("loads and saves $sectionId without a ready sandbox", async (scenario) => {
  const setup = await fixture("unavailable");
  const globalToolsPath = globalToolProfilePath(setup.agentDir);
  await mkdir(dirname(globalToolsPath), { recursive: true });
  await writeFile(globalToolsPath, JSON.stringify(defaultToolProfile()));
  const section = setup.sections.find((section) => section.id === scenario.sectionId)!;
  const draft = await section.load({ cwd: setup.root } as never);
  const path = scenario.profilePath(setup.agentDir, setup.project);
  expect(await privateStorage.readPrivateText(path)).toBeUndefined();
  await draft.apply(scenario.submitted);
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved).toMatchObject(scenario.expectedProfile);
  expect(setup.getSession).not.toHaveBeenCalled();
});

it("project tool edits from a non-Git child retain the ancestor profile without creating a base", async () => {
  const setup = await fixture("unavailable");
  const child = join(setup.root, "src");
  await mkdir(child);
  const globalToolsPath = globalToolProfilePath(setup.agentDir);
  await mkdir(dirname(globalToolsPath), { recursive: true });
  const globalTools = defaultToolProfile();
  globalTools.tools.jq = {
    kind: "recipe",
    version: "1.7.1",
    command: ["install-jq", "1.7.1"],
    environment: {},
    executable: "/usr/local/bin/jq",
    prerequisites: ["sh"],
    dependencies: [],
  };
  const globalToolsText = JSON.stringify(globalTools);
  await writeFile(globalToolsPath, globalToolsText);
  const globalBasePath = globalDefinitionPath(setup.agentDir);
  const globalBaseText = JSON.stringify({ image: "docker.io/library/debian:trixie" });
  await writeFile(globalBasePath, globalBaseText);
  const projectToolsPath = projectToolProfilePath(setup.agentDir, setup.project);
  await mkdir(dirname(projectToolsPath), { recursive: true });
  await writeFile(projectToolsPath, JSON.stringify({ version: 1, tools: {}, exclude: [] }));
  const section = setup.sections.find((section) => section.id === "sandbox-tools-project")!;
  const draft = await section.load({ cwd: child } as never);
  expect(draft.value).toEqual({ version: 1, tools: {}, exclude: [] });
  await draft.apply({ ...draft.value, exclude: ["jq"] });
  expect(JSON.parse(await readFile(projectToolsPath, "utf8"))).toEqual({
    version: 1,
    tools: {},
    exclude: ["jq"],
  });
  expect(await resolveSandboxProject(child, setup.agentDir)).toEqual(setup.project);
  expect(
    await privateStorage.readPrivateText(projectDefinitionPath(setup.agentDir, setup.project)),
  ).toBeUndefined();
  expect(await readFile(globalBasePath, "utf8")).toBe(globalBaseText);
  expect(await readFile(globalToolsPath, "utf8")).toBe(globalToolsText);
  expect(setup.getSession).not.toHaveBeenCalled();
});

it("rebuilding still requires a ready sandbox", async () => {
  const setup = await fixture("unavailable");
  const section = setup.sections.find((section) => section.id === "sandbox")!;
  const action = section.actions!.find((action) => action.id === "rebuild")!;
  await expect(
    action.run({ cwd: setup.root, isIdle: () => true } as never, new AbortController().signal),
  ).rejects.toThrow("Sandbox container is not ready");
  expect(setup.getSession).toHaveBeenCalledOnce();
});

it("omits the retired model-assisted setup toggle from general settings", async () => {
  const setup = await fixture();
  const section = setup.sections.find((section) => section.id === "sandbox")!;
  expect(section.fields.map((field) => field.path)).toEqual([
    "permission",
    "sandbox.hostEnvironment",
    "sandbox.startupTimeoutMs",
    "sandbox.buildTimeoutMs",
  ]);
});

it("offers tool generation alongside manual settings without starting a sandbox", async () => {
  const setup = await fixture("unavailable");
  const actionsBySection = Object.fromEntries(
    setup.sections.map((section) => [
      section.id,
      section.actions?.map((action) => action.id) ?? [],
    ]),
  );
  expect(actionsBySection).toEqual({
    sandbox: ["rebuild"],
    "host-commands": [],
    "sandbox-base-global": [],
    "sandbox-tools-global": ["add-tool"],
    "sandbox-base-project": [],
    "sandbox-tools-project": ["add-tool"],
    "sandbox-environment": [],
  });
  for (const id of ["sandbox-tools-global", "sandbox-tools-project"]) {
    const section = setup.sections.find((section) => section.id === id)!;
    expect(section.fields.map((field) => field.path)).toEqual(["tools", "exclude"]);
  }
  expect(setup.getSession).not.toHaveBeenCalled();
});

it("accepted native rule edits save without a second authorization", async () => {
  const setup = await fixture();
  const section = setup.sections.find((section) => section.id === "host-commands")!;
  const confirm = vi.fn();
  const select = vi.fn();
  const ctx = { cwd: setup.root, ui: { confirm, select } };
  const draft = await section.load(ctx as never);
  const path = hostCommandProfilePath(setup.agentDir, setup.project);
  await expect(readFile(path, "utf8")).rejects.toThrow();
  await draft.apply({ hostCommands: [{ executable: "dotnet" }, { script: "./build.sh" }] });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    hostCommands: [{ executable: "dotnet" }, { script: "./build.sh" }],
  });
  expect(section.fields[0]?.edit).toBeTypeOf("function");
  expect(confirm).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect((await section.load(ctx as never)).value).toEqual({
    hostCommands: [{ executable: "dotnet" }, { script: "./build.sh" }],
  });
});

it("hides base environment and build credentials while preserving them across ordinary edits", async () => {
  const setup = await fixture();
  const path = globalDefinitionPath(setup.agentDir);
  await mkdir(dirname(path), { recursive: true });
  const definition = {
    build: { dockerfile: "Containerfile", args: { TOKEN: "build-credential" } },
    containerEnv: { TOKEN: "container-credential" },
    remoteEnv: { TOKEN: "remote-credential" },
  };
  await writeFile(path, JSON.stringify(definition));
  const section = setup.sections.find((section) => section.id === "sandbox-base-global")!;
  const draft = await section.load({ cwd: setup.root } as never);
  expect(JSON.stringify(draft.value.definition)).not.toContain("credential");
  const secretFieldPaths = section.fields
    .filter((field) => field.secret)
    .map((field) => field.path);
  expect(secretFieldPaths).toEqual(["containerEnv", "remoteEnv", "buildArgs"]);
  const rendered: string[] = [];
  const ctx = settingsContextThatCapturesRenderedLines(rendered, setup.root);
  await openSettingsSection(ctx, section, new AbortController().signal);
  expect(rendered.join("\n")).not.toContain("credential");
  await draft.apply({
    ...draft.value,
    definition: { ...(draft.value.definition as object), name: "Edited base" },
  });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...definition, name: "Edited base" });
});

it("does not publish native authority when Apply is cancelled during pending publication", async () => {
  const setup = await fixture();
  const section = setup.sections.find((section) => section.id === "host-commands")!;
  const draft = await section.load({ cwd: setup.root } as never);
  const originalPublish = privateStorage.publishPrivateText;
  const { promise: publicationWait, resolve: continuePublication } = Promise.withResolvers<void>();
  const publicationStarted = vi.fn();
  vi.spyOn(privateStorage, "publishPrivateText").mockImplementationOnce(async (...args) => {
    publicationStarted();
    await publicationWait;
    return originalPublish(...args);
  });
  const cancellation = new AbortController();
  const pending = draft.apply({ hostCommands: [{ executable: "dotnet" }] }, cancellation.signal);
  const rejected = expect(pending).rejects.toThrow("Cancelled settings");
  await vi.waitFor(() => expect(publicationStarted).toHaveBeenCalledOnce());
  cancellation.abort(new Error("Cancelled settings"));
  continuePublication();
  await rejected;
  expect(
    await privateStorage.readPrivateText(hostCommandProfilePath(setup.agentDir, setup.project)),
  ).toBeUndefined();
});

it("editing General Settings migrates legacy settings without a setup command or confirmation", async () => {
  const setup = await fixture();
  const path = configPath(setup.agentDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(DEFAULT_CONFIG));
  const section = setup.sections.find((section) => section.id === "sandbox")!;
  const rendered: string[] = [];
  const ctx = settingsContextThatCapturesRenderedLines(rendered, setup.root);
  const confirm = vi.fn();
  ctx.ui.confirm = confirm;
  const choices = ["field:sandbox.startupTimeoutMs", "60000", "back"];
  const custom = ctx.ui.custom;
  ctx.ui.custom = (async (...args: Parameters<ExtensionContext["ui"]["custom"]>) => {
    await custom(...args);
    return choices.shift();
  }) as ExtensionContext["ui"]["custom"];
  await openSettingsSection(ctx, section, new AbortController().signal);
  const loaded = await loadSandboxSettings(setup.agentDir);
  expect(loaded.needsMigration).toBe(false);
  expect(loaded.settings.permission).toEqual(DEFAULT_CONFIG.permission);
  expect(loaded.settings.sandbox.startupTimeoutMs).toBe(60_000);
  expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("auto");
  expect(confirm).not.toHaveBeenCalled();
  expect(rendered.join("\n")).not.toContain("Apply changes");
});

it("removing a host rule publishes it immediately without a done or Apply button", async () => {
  const setup = await fixture();
  const path = hostCommandProfilePath(setup.agentDir, setup.project);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ hostCommands: [{ executable: "dotnet" }] }));
  const section = setup.sections.find((section) => section.id === "host-commands")!;
  const rendered: string[] = [];
  const ctx = settingsContextThatCapturesRenderedLines(rendered, setup.root);
  const choices = ["field:hostCommands", "remove:0", "back"];
  const custom = ctx.ui.custom;
  ctx.ui.custom = (async (...args: Parameters<ExtensionContext["ui"]["custom"]>) => {
    await custom(...args);
    return choices.shift();
  }) as ExtensionContext["ui"]["custom"];
  await openSettingsSection(ctx, section, new AbortController().signal);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ hostCommands: [] });
  expect(rendered.join("\n")).not.toContain("Apply changes");
  expect(rendered.join("\n")).not.toContain("Use these draft rules");
});

it("invalid permission settings remain a rejected draft", async () => {
  const setup = await fixture();
  const section = setup.sections.find((section) => section.id === "sandbox")!;
  const draft = await section.load({ cwd: setup.root } as never);
  await expect(draft.apply({ ...draft.value, permission: { bash: "invalid" } })).rejects.toThrow();
});
