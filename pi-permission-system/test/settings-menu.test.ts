import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverSettingsSections, openSettingsSection } from "@paulsteele/pi-shared-ui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { globalDefinitionPath } from "../src/sandbox/definition.ts";
import { registerSandboxSettings } from "../src/sandbox/settings-menu.ts";
import { hostCommandProfilePath } from "../src/sandbox/host-command-profile.ts";
import * as privateStorage from "../src/sandbox/storage.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-settings-"));
  directories.push(directory);
  const root = join(directory, "project");
  const agentDir = join(directory, "agent");
  await mkdir(root);
  const project = { id: "a".repeat(64), kind: "projects" as const, root };
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
  registerSandboxSettings(
    pi as never,
    agentDir,
    () => ({ options: { resolved: { project } } }) as never,
  );
  return { sections: discoverSettingsSections(pi), root, agentDir, project };
}

function settingsContextThatCapturesRenderedLines(rendered: string[]): ExtensionContext {
  return {
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

it("only Apply publishes native project rules and does not prompt for a second authorization", async () => {
  const setup = await fixture();
  const section = setup.sections.find((section) => section.id === "host-commands")!;
  const draft = await section.load({} as never);
  const path = hostCommandProfilePath(setup.agentDir, setup.project);
  await expect(readFile(path, "utf8")).rejects.toThrow();
  await draft.apply({ hostCommands: [{ executable: "dotnet" }, { script: "./build.sh" }] });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    hostCommands: [{ executable: "dotnet" }, { script: "./build.sh" }],
  });
  expect(section.fields[0]?.edit).toBeTypeOf("function");
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
  const draft = await section.load({} as never);
  expect(JSON.stringify(draft.value.definition)).not.toContain("credential");
  const secretFieldPaths = section.fields
    .filter((field) => field.secret)
    .map((field) => field.path);
  expect(secretFieldPaths).toEqual(["containerEnv", "remoteEnv", "buildArgs"]);
  const rendered: string[] = [];
  const ctx = settingsContextThatCapturesRenderedLines(rendered);
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
  const draft = await section.load({} as never);
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

it("invalid permission settings remain a rejected draft", async () => {
  const setup = await fixture();
  const section = setup.sections.find((section) => section.id === "sandbox")!;
  const draft = await section.load({} as never);
  await expect(draft.apply({ ...draft.value, permission: { bash: "invalid" } })).rejects.toThrow();
});
