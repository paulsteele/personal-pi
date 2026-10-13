import { readdir, realpath } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join, resolve } from "node:path";
import {
  projectStoragePath,
  resolveProjectLocation,
  type ProjectLocation,
} from "@paulsteele/pi-project-locations";
import { z } from "zod";
import { cliHostEnvironment, readDevcontainerConfiguration } from "./devcontainer-cli.ts";
import { sandboxStorageRoot } from "./settings.ts";
import { canonicalPath, sha256Hex, readPrivateText } from "./storage.ts";
import {
  resolveEnvironmentLayers,
  layeredDefinition,
  type EnvironmentLayers,
} from "./environment-layers.ts";
import { projectToolProfilePath } from "./tool-profile.ts";
import { projectEnvironmentPath } from "./project-environment.ts";
import { authorizeBuildInputs } from "./build-inputs.ts";
import { hostCommandProfilePath } from "./host-command-profile.ts";

const commandArguments = z.array(z.string().max(16_000)).max(128);
const lifecycleCommand = z.union([
  z.string().max(16_000),
  commandArguments,
  z.record(z.string().min(1).max(100), z.union([z.string().max(16_000), commandArguments])),
]);
const environmentVariables = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().max(16_000),
);
const mount = z.union([
  z.string().max(4096),
  z
    .object({
      type: z.enum(["bind", "volume", "tmpfs"]),
      source: z.string().max(4096).optional(),
      target: z.string().max(4096),
      readOnly: z.boolean().optional(),
    })
    .strict(),
]);

export const devcontainerDefinitionSchema = z
  .object({
    name: z.string().max(200).optional(),
    image: z.string().min(1).max(500).optional(),
    build: z
      .object({
        dockerfile: z.string().min(1).max(4096),
        context: z.string().min(1).max(4096).optional(),
        args: environmentVariables.optional(),
        target: z.string().min(1).max(200).optional(),
        cacheFrom: z.union([z.string(), z.array(z.string())]).optional(),
      })
      .strict()
      .optional(),
    dockerFile: z.string().min(1).max(4096).optional(),
    context: z.string().min(1).max(4096).optional(),
    workspaceFolder: z.string().min(1).max(4096).optional(),
    workspaceMount: z.string().min(1).max(4096).optional(),
    mounts: z.array(mount).max(64).optional(),
    containerUser: z.string().min(1).max(100).optional(),
    remoteUser: z.string().min(1).max(100).optional(),
    updateRemoteUserUID: z.boolean().optional(),
    userEnvProbe: z
      .enum(["none", "interactiveShell", "loginShell", "loginInteractiveShell"])
      .optional(),
    containerEnv: environmentVariables.optional(),
    remoteEnv: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(16_000).nullable())
      .optional(),
    initializeCommand: lifecycleCommand.optional(),
    onCreateCommand: lifecycleCommand.optional(),
    updateContentCommand: lifecycleCommand.optional(),
    postCreateCommand: lifecycleCommand.optional(),
    postStartCommand: lifecycleCommand.optional(),
    postAttachCommand: lifecycleCommand.optional(),
    waitFor: z
      .enum([
        "initializeCommand",
        "onCreateCommand",
        "updateContentCommand",
        "postCreateCommand",
        "postStartCommand",
      ])
      .optional(),
    overrideCommand: z.boolean().optional(),
    shutdownAction: z.enum(["none", "stopContainer"]).optional(),
    init: z.boolean().optional(),
    appPort: z
      .union([z.number().int(), z.string(), z.array(z.union([z.number().int(), z.string()]))])
      .optional(),
    forwardPorts: z
      .array(z.union([z.number().int(), z.string()]))
      .max(64)
      .optional(),
    portsAttributes: z.record(z.string(), z.unknown()).optional(),
    otherPortsAttributes: z.record(z.string(), z.unknown()).optional(),
    customizations: z.record(z.string(), z.unknown()).optional(),
    hostRequirements: z
      .object({
        cpus: z.number().positive().optional(),
        memory: z.string().optional(),
        storage: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((definition, context) => {
    const hasImageRecipe = Boolean(definition.image);
    const hasBuildRecipe = Boolean(definition.build || definition.dockerFile);
    const usesExactlyOneRecipe = hasImageRecipe !== hasBuildRecipe;
    if (!usesExactlyOneRecipe) {
      context.addIssue({
        code: "custom",
        message: "Use exactly one image or Containerfile build recipe",
      });
    }
  });

export type DevcontainerDefinition = z.output<typeof devcontainerDefinitionSchema>;
export interface SelectedDefinition {
  tier: "project" | "local" | "global";
  path: string;
  project: ProjectLocation;
  startupDirectory: string;
}
export interface ResolvedDefinition extends SelectedDefinition {
  definition: DevcontainerDefinition;
  revision: string;
  sourceText: string;
  containerfile?: string;
  buildContext?: string;
  baseRevision?: string;
  layers?: EnvironmentLayers;
}

export function globalDefinitionPath(agentDir: string): string {
  return join(sandboxStorageRoot(agentDir), "global", "devcontainer.json");
}
export function projectDefinitionPath(agentDir: string, project: ProjectLocation): string {
  return projectStoragePath(
    sandboxStorageRoot(agentDir),
    project,
    "devcontainer/devcontainer.json",
  );
}

export async function discoverLocalDefinitions(projectRoot: string): Promise<string[]> {
  const primary = join(projectRoot, ".devcontainer", "devcontainer.json");
  if (await readPrivateText(primary)) {
    return [primary];
  }
  const alternate = join(projectRoot, ".devcontainer.json");
  if (await readPrivateText(alternate)) {
    return [alternate];
  }
  let entries;
  try {
    entries = await readdir(join(projectRoot, ".devcontainer"), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const choices: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) {
      const path = join(projectRoot, ".devcontainer", entry.name, "devcontainer.json");
      if (await readPrivateText(path)) {
        choices.push(path);
      }
    }
  }
  return choices;
}

export async function resolveSandboxProject(
  cwd: string,
  agentDir: string,
): Promise<ProjectLocation> {
  return resolveProjectLocation(cwd, {
    hasProfile: async (candidate) => {
      const paths = [
        projectDefinitionPath(agentDir, candidate),
        projectToolProfilePath(agentDir, candidate),
        projectEnvironmentPath(agentDir, candidate),
        hostCommandProfilePath(agentDir, candidate),
      ];
      return (await Promise.all(paths.map(readPrivateText))).some(Boolean);
    },
  });
}

export async function selectDefinition(options: {
  agentDir: string;
  cwd: string;
  choose?: (paths: readonly string[]) => Promise<string | undefined>;
}): Promise<SelectedDefinition> {
  const startupDirectory = await realpath(options.cwd);
  const project = await resolveSandboxProject(startupDirectory, options.agentDir);
  const privatePath = projectDefinitionPath(options.agentDir, project);
  if (await readPrivateText(privatePath)) {
    return { tier: "project", path: privatePath, project, startupDirectory };
  }
  const locals = await discoverLocalDefinitions(project.root);
  if (locals.length) {
    let selectedPath: string | undefined;
    if (locals.length === 1) {
      selectedPath = locals[0];
    } else {
      selectedPath = await options.choose?.(locals);
    }
    if (!selectedPath || !locals.includes(selectedPath)) {
      throw new Error(`Choose a devcontainer definition explicitly: ${locals.join(", ")}`);
    }
    return { tier: "local", path: selectedPath, project, startupDirectory };
  }
  const global = globalDefinitionPath(options.agentDir);
  if (!(await readPrivateText(global))) {
    throw new Error(`No devcontainer definition; configure ${global} with /sandbox setup global`);
  }
  return { tier: "global", path: global, project, startupDirectory };
}

export function validateHostEnvironmentImports(
  sourceText: string,
  allowedVariableNames: readonly string[],
): void {
  for (const match of sourceText.matchAll(/\$\{localEnv:([^}:]+)(?::[^}]*)?\}/g)) {
    const name = match[1];
    if (!allowedVariableNames.includes(name) || process.env[name] === undefined) {
      throw new Error(
        `Host environment import ${name} requires an available, explicitly approved variable`,
      );
    }
  }
}

export async function resolveDefinition(options: {
  selected: SelectedDefinition;
  hostEnvironment?: readonly string[];
  signal?: AbortSignal;
  readConfiguration?: typeof readDevcontainerConfiguration;
  agentDir?: string;
  confirmBuildInput?: (preview: string) => Promise<boolean>;
}): Promise<ResolvedDefinition> {
  const { selected } = options;
  const source = await readPrivateText(selected.path);
  if (!source) {
    throw new Error(`Devcontainer definition disappeared: ${selected.path}`);
  }
  validateHostEnvironmentImports(source.text, options.hostEnvironment ?? []);
  const configuration = JSON.parse(
    await (options.readConfiguration ?? readDevcontainerConfiguration)({
      configPath: selected.path,
      workspaceFolder: selected.startupDirectory,
      env: cliHostEnvironment(options.hostEnvironment),
      signal: options.signal,
    }),
  ) as { configuration?: Record<string, unknown> };
  if (!configuration.configuration) {
    throw new Error("Devcontainer CLI did not return configuration");
  }
  const { configFilePath: _configFilePath, ...fields } = configuration.configuration;
  const definition = devcontainerDefinitionSchema.parse(fields);
  if ((await readPrivateText(selected.path))?.revision !== source.revision) {
    throw new Error("Devcontainer definition changed during resolution");
  }
  const file = definition.build?.dockerfile ?? definition.dockerFile;
  const containerfile = file
    ? await canonicalPath(resolve(dirname(selected.path), file))
    : undefined;
  const buildContext = file
    ? await canonicalPath(
        resolve(dirname(selected.path), definition.build?.context ?? definition.context ?? "."),
      )
    : undefined;
  const authorityAgentDir = options.agentDir ?? getAgentDir();
  await authorizeBuildInputs({
    projectRoot: selected.project.root,
    definitionPath: selected.path,
    containerfile,
    buildContext,
    privateStorage: sandboxStorageRoot(authorityAgentDir),
    confirm: options.confirmBuildInput,
    signal: options.signal,
  });
  const containerfileText = containerfile ? await readPrivateText(containerfile) : undefined;
  if (containerfile && !containerfileText) {
    throw new Error(`Missing Containerfile: ${containerfile}`);
  }
  const baseRevision = sha256Hex(
    JSON.stringify([source.revision, definition, containerfileText?.revision, buildContext]),
  );
  const layers = options.agentDir
    ? await resolveEnvironmentLayers(options.agentDir, selected.project)
    : undefined;
  let effectiveDefinition = definition;
  let substitutedLayers = layers;
  if (layers) {
    const projectEnvironmentText = JSON.stringify(layers.projectEnvironment);
    validateHostEnvironmentImports(projectEnvironmentText, options.hostEnvironment ?? []);
    const workspace = definition.workspaceFolder ?? selected.startupDirectory;
    const jsonStringContent = (value: string) => JSON.stringify(value).slice(1, -1);
    const substituteProjectEnvironment = (text: string) =>
      text.replace(
        /\$\{(localWorkspaceFolder|containerWorkspaceFolder|localEnv:([^}:]+)(?::[^}]*)?)\}/g,
        (_match, variable: string, environmentName?: string) => {
          if (variable === "localWorkspaceFolder") {
            return jsonStringContent(selected.startupDirectory);
          }
          if (variable === "containerWorkspaceFolder") {
            return jsonStringContent(workspace);
          }
          return jsonStringContent(process.env[environmentName ?? ""] ?? "");
        },
      );
    const substitutedEnvironment = substituteProjectEnvironment(projectEnvironmentText);
    substitutedLayers = {
      ...layers,
      projectEnvironment: JSON.parse(substitutedEnvironment),
    };
    effectiveDefinition = devcontainerDefinitionSchema.parse(
      layeredDefinition(definition, substitutedLayers),
    );
  }
  return {
    ...selected,
    definition: effectiveDefinition,
    revision: layers ? sha256Hex(JSON.stringify([baseRevision, layers.revision])) : baseRevision,
    baseRevision,
    ...(substitutedLayers ? { layers: substitutedLayers } : {}),
    sourceText: source.text,
    ...(containerfile ? { containerfile, buildContext } : {}),
  };
}
