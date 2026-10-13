import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  registerSettingsSection as contributeSettingsSection,
  chooseMenu,
  inputPanel,
  type SettingsSection,
} from "@paulsteele/pi-shared-ui";
import { isAbsolute } from "node:path";
import {
  globalToolProfilePath,
  projectToolProfilePath,
  loadToolProfile,
  defaultToolProfile,
  parseToolProfile,
  resolveToolProfiles,
} from "./tool-profile.ts";
import { parseProjectEnvironment, projectEnvironmentPath } from "./project-environment.ts";
import {
  hostCommandProfilePath,
  hostCommandProfileSchema,
  loadHostCommandProfile,
} from "./host-command-profile.ts";
import { loadSandboxSettings, parseSandboxSettings, saveSandboxSettings } from "./settings.ts";
import { publishPrivateText, readPrivateText } from "./storage.ts";
import type { SandboxSession } from "./session.ts";
import {
  devcontainerDefinitionSchema,
  globalDefinitionPath,
  projectDefinitionPath,
  resolveSandboxProject,
} from "./definition.ts";

async function editHostRules(
  ctx: ExtensionContext,
  current: unknown,
  signal: AbortSignal,
): Promise<{ value: unknown } | undefined> {
  const rules = hostCommandProfileSchema.parse({ hostCommands: current ?? [] }).hostCommands;
  for (;;) {
    const choice = await chooseMenu(
      ctx,
      "Project Host Commands",
      [
        ...rules.map((rule, index) => {
          const ruleName = "script" in rule ? rule.script : rule.executable;
          return { id: `remove:${index}`, label: `Remove ${ruleName}` };
        }),
        {
          id: "script",
          label: "Add exact project script",
          description: "Project-root-relative path, such as ./build.sh",
        },
        {
          id: "executable",
          label: "Add host executable",
          description: "Any arguments; optional absolute binary path",
        },
        { id: "back", label: "Back", description: "Accepted rule edits save immediately" },
      ],
      signal,
    );
    if (!choice || choice === "back") {
      return undefined;
    }
    if (choice.startsWith("remove:")) {
      rules.splice(Number(choice.slice("remove:".length)), 1);
      return { value: rules };
    }
    const name = await inputPanel(
      ctx,
      choice === "script" ? "Project-relative script" : "Host executable name",
      "",
      signal,
    );
    if (!name?.trim()) {
      continue;
    }
    const path =
      choice === "executable"
        ? await inputPanel(ctx, "Absolute host binary path (blank uses host PATH)", "", signal)
        : undefined;
    if (choice === "executable" && path === undefined) {
      continue;
    }
    const trimmedName = name.trim();
    let rule: { script: string } | { executable: string; path?: string };
    if (choice === "script") {
      rule = { script: trimmedName };
    } else {
      const trimmedPath = path?.trim();
      if (trimmedPath && !isAbsolute(trimmedPath)) {
        ctx.ui.notify("Host binary paths must be absolute; rule not added.", "error");
        continue;
      }
      rule = { executable: trimmedName, ...(trimmedPath ? { path: trimmedPath } : {}) };
    }
    const validated = hostCommandProfileSchema.parse({ hostCommands: [...rules, rule] });
    return { value: validated.hostCommands };
  }
}

export function registerSandboxSettings(
  pi: ExtensionAPI,
  agentDir: string,
  getSession: () => SandboxSession,
): void {
  const registerSandboxSettingsSection = (owner: ExtensionAPI, section: SettingsSection) =>
    contributeSettingsSection(owner, {
      ...section,
      plugin: {
        id: "sandbox",
        title: "Sandbox",
        description: "Permissions, native commands, container bases, tools, and environment",
      },
    });
  registerSandboxSettingsSection(pi, {
    id: "sandbox",
    title: "General Settings",
    description: "Permission rules, host environment imports, and timeouts",
    effect:
      "Edits save immediately. Permission rules apply on the next action; startup/build settings apply on next sandbox startup.",
    fields: [
      { path: "permission", label: "Explicit permission rules", kind: "json" },
      { path: "sandbox.hostEnvironment", label: "Imported host environment names", kind: "json" },
      { path: "sandbox.startupTimeoutMs", label: "Startup timeout (ms)", kind: "number" },
      { path: "sandbox.buildTimeoutMs", label: "Build timeout (ms)", kind: "number" },
    ],
    async load() {
      const loaded = await loadSandboxSettings(agentDir);
      return {
        value: loaded.settings,
        needsInitialPublication: loaded.needsMigration || loaded.revision === undefined,
        async apply(value, signal) {
          const settings = parseSandboxSettings(value);
          signal?.throwIfAborted();
          await saveSandboxSettings(agentDir, settings, loaded.revision, signal);
        },
      };
    },
    actions: [
      {
        id: "rebuild",
        label: "Rebuild current sandbox",
        description: "Uses the existing rebuild approval",
        async run(ctx, signal) {
          if (!ctx.isIdle()) {
            throw new Error("Wait for the agent to finish before rebuilding");
          }
          await getSession().rebuild(signal);
        },
      },
    ],
  });
  registerSandboxSettingsSection(pi, {
    id: "host-commands",
    title: "Project Host Commands",
    description: "Authorize native executables and exact project scripts",
    effect:
      "Accepted edits authorize native commands with any arguments. Rules apply to subsequent Bash calls.",
    fields: [
      {
        path: "hostCommands",
        label: "Host rules",
        kind: "json",
        edit: editHostRules,
        description:
          "Add/remove native scripts and executables. Each accepted edit saves and authorizes the rule.",
      },
    ],
    async load(ctx) {
      const project = await resolveSandboxProject(ctx.cwd, agentDir);
      const profile = await loadHostCommandProfile(agentDir, project);
      return {
        value: { hostCommands: profile.rules },
        async apply(value, signal) {
          const next = hostCommandProfileSchema.parse(value);
          if (
            next.hostCommands.some((rule) => "path" in rule && rule.path && !isAbsolute(rule.path))
          ) {
            throw new Error("Host binary paths must be absolute");
          }
          const text = `${JSON.stringify(next, null, 2)}\n`;
          signal?.throwIfAborted();
          await publishPrivateText(
            hostCommandProfilePath(agentDir, project),
            text,
            profile.revision,
            signal,
          );
        },
      };
    },
  });
  for (const scope of ["global", "project"] as const) {
    registerSandboxSettingsSection(pi, {
      id: `sandbox-base-${scope}`,
      title: `${scope === "global" ? "Global" : "Project"} Container Base`,
      description: "Image/build recipe, workspace declarations, ports, and lifecycle",
      effect:
        "Base definition saved. Reload validates it; expanded mounts, ports, and host initialization retain separate approvals.",
      fields: [
        {
          path: "definition",
          label: "Devcontainer definition",
          kind: "json",
          description:
            "Standard supported Dev Container fields; no privileged mode, host sockets, or Compose.",
        },
        { path: "containerEnv", label: "Container environment", kind: "json", secret: true },
        { path: "remoteEnv", label: "Remote environment", kind: "json", secret: true },
        { path: "buildArgs", label: "Build arguments", kind: "json", secret: true },
      ],
      async load(ctx) {
        const path =
          scope === "global"
            ? globalDefinitionPath(agentDir)
            : projectDefinitionPath(agentDir, await resolveSandboxProject(ctx.cwd, agentDir));
        const stored = await readPrivateText(path);
        const definition = stored
          ? JSON.parse(stored.text)
          : { image: "docker.io/library/debian:bookworm" };
        const { containerEnv, remoteEnv, ...definitionWithoutSecrets } = definition;
        const secretBuildArgs = definitionWithoutSecrets.build?.args;
        if (definitionWithoutSecrets.build) {
          definitionWithoutSecrets.build = { ...definitionWithoutSecrets.build };
          delete definitionWithoutSecrets.build.args;
        }
        return {
          value: {
            definition: definitionWithoutSecrets,
            containerEnv,
            remoteEnv,
            buildArgs: secretBuildArgs,
          },
          needsInitialPublication: !stored,
          async apply(value, signal) {
            const submittedDefinition = value.definition as Record<string, unknown>;
            const buildConfiguration = submittedDefinition.build as
              | Record<string, unknown>
              | undefined;
            const definitionWithSecrets = { ...submittedDefinition };
            if (value.containerEnv !== undefined) {
              definitionWithSecrets.containerEnv = value.containerEnv;
            }
            if (value.remoteEnv !== undefined) {
              definitionWithSecrets.remoteEnv = value.remoteEnv;
            }
            if (buildConfiguration) {
              const buildWithSecretArgs = { ...buildConfiguration };
              if (value.buildArgs !== undefined) {
                buildWithSecretArgs.args = value.buildArgs;
              }
              definitionWithSecrets.build = buildWithSecretArgs;
            }
            const validatedDefinition = devcontainerDefinitionSchema.parse(definitionWithSecrets);
            signal?.throwIfAborted();
            await publishPrivateText(
              path,
              `${JSON.stringify(validatedDefinition, null, 2)}\n`,
              stored?.revision,
              signal,
            );
          },
        };
      },
    });
    registerSandboxSettingsSection(pi, {
      id: `sandbox-tools-${scope}`,
      title: `${scope === "global" ? "Global" : "Project"} Sandbox Tools`,
      description: "Pinned language servers and development tool recipes",
      effect:
        "Saved private tools. Reload/rebuild adopts changes and retains existing build approvals.",
      fields: [
        {
          path: "tools",
          label: scope === "global" ? "Global tool definitions" : "Project tool recipes",
          kind: "json",
        },
        { path: "exclude", label: "Excluded optional tools", kind: "json" },
      ],
      async load(ctx) {
        const path =
          scope === "global"
            ? globalToolProfilePath(agentDir)
            : projectToolProfilePath(agentDir, await resolveSandboxProject(ctx.cwd, agentDir));
        const stored = await loadToolProfile(path);
        const value =
          stored?.profile ??
          (scope === "global"
            ? defaultToolProfile()
            : parseToolProfile({ version: 1, tools: {}, exclude: [] }));
        return {
          value,
          needsInitialPublication: !stored,
          async apply(next, signal) {
            const profile = parseToolProfile(next);
            const global =
              scope === "global"
                ? profile
                : (await loadToolProfile(globalToolProfilePath(agentDir)))?.profile;
            if (!global) {
              throw new Error("Configure global tools first");
            }
            resolveToolProfiles(global, scope === "project" ? profile : undefined);
            signal?.throwIfAborted();
            await publishPrivateText(
              path,
              `${JSON.stringify(profile, null, 2)}\n`,
              stored?.revision,
              signal,
            );
          },
        };
      },
    });
  }
  registerSandboxSettingsSection(pi, {
    id: "sandbox-environment",
    title: "Project Environment",
    description: "SDK/native installs, files, environment, and lifecycle hooks",
    effect:
      "Saved private project requirements. Reload/rebuild adopts changes; mounts remain separately approved.",
    fields: [
      { path: "installations", label: "Pinned installations", kind: "json" },
      { path: "files", label: "Build companion files", kind: "json" },
      { path: "containerEnv", label: "Container environment", kind: "json", secret: true },
      { path: "remoteEnv", label: "Tool environment", kind: "json", secret: true },
      { path: "onCreateCommand", label: "On create command", kind: "json" },
      { path: "updateContentCommand", label: "Update content command", kind: "json" },
      { path: "postCreateCommand", label: "Post-create command", kind: "json" },
      { path: "postStartCommand", label: "Post-start command", kind: "json" },
      { path: "postAttachCommand", label: "Post-attach command", kind: "json" },
    ],
    async load(ctx) {
      const project = await resolveSandboxProject(ctx.cwd, agentDir);
      const path = projectEnvironmentPath(agentDir, project);
      const stored = await readPrivateText(path);
      const value = parseProjectEnvironment(stored ? JSON.parse(stored.text) : { version: 1 });
      return {
        value,
        async apply(next, signal) {
          const environment = parseProjectEnvironment(next);
          signal?.throwIfAborted();
          await publishPrivateText(
            path,
            `${JSON.stringify(environment, null, 2)}\n`,
            stored?.revision,
            signal,
          );
        },
      };
    },
  });
}
