import type { ProjectLocation } from "@paulsteele/pi-project-locations";
import type { DevcontainerDefinition } from "./definition.ts";
import { buildContentKey } from "./tool-cache.ts";
import {
  applyProjectEnvironment,
  loadProjectEnvironment,
  parseProjectEnvironment,
  projectEnvironmentPath,
  type ProjectEnvironment,
} from "./project-environment.ts";
import {
  globalToolProfilePath,
  loadToolProfile,
  projectToolProfilePath,
  resolveToolProfiles,
  type ResolvedTool,
  type StoredToolProfile,
} from "./tool-profile.ts";
import { readPrivateText } from "./storage.ts";
import { STANDARD_TOOL_CATALOG } from "./tool-catalog.ts";
import { readFile } from "node:fs/promises";

async function provisioningCodeRevision(): Promise<string> {
  const provisioningModules = [
    "tool-artifacts.ts",
    "tool-downloads.ts",
    "tool-builders.ts",
    "tool-platform.ts",
    "tool-assembly.ts",
    "tool-provisioning.ts",
    "tool-image-mounts.ts",
    "tool-mount-capability.ts",
    "image-tool-recipe.ts",
  ];
  const sources = await Promise.all(
    provisioningModules.map((name) => readFile(new URL(name, import.meta.url), "utf8")),
  );
  return buildContentKey({ catalog: STANDARD_TOOL_CATALOG, sources });
}

export interface EnvironmentLayers {
  revision: string;
  globalTools: StoredToolProfile;
  projectTools?: StoredToolProfile;
  projectEnvironment: ProjectEnvironment;
  sources: { path: string; revision?: string }[];
  tools: ResolvedTool[];
}

export async function resolveEnvironmentLayers(
  agentDir: string,
  project: ProjectLocation,
): Promise<EnvironmentLayers> {
  const globalPath = globalToolProfilePath(agentDir);
  const projectPath = projectToolProfilePath(agentDir, project);
  const environmentPath = projectEnvironmentPath(agentDir, project);
  const [globalTools, projectTools, environment] = await Promise.all([
    loadToolProfile(globalPath),
    loadToolProfile(projectPath),
    loadProjectEnvironment(environmentPath),
  ]);
  if (!globalTools) {
    throw new Error(
      `Global tooling is not configured. Run /sandbox setup global tools to approve ${globalPath}`,
    );
  }
  const sources = [
    { path: globalPath, revision: globalTools.revision },
    { path: projectPath, revision: projectTools?.revision },
    { path: environmentPath, revision: environment?.revision },
  ];
  return {
    revision: buildContentKey({ sources, provisioning: await provisioningCodeRevision() }),
    globalTools,
    projectTools,
    projectEnvironment: environment?.environment ?? parseProjectEnvironment({ version: 1 }),
    sources,
    tools: resolveToolProfiles(globalTools.profile, projectTools?.profile),
  };
}

export function configuredEnvironmentSourcePaths(
  layers: EnvironmentLayers | undefined,
): string[] | undefined {
  return layers?.sources
    .filter((source) => source.revision !== undefined)
    .map((source) => source.path);
}

export async function validateEnvironmentSources(layers: EnvironmentLayers): Promise<void> {
  for (const source of layers.sources) {
    if ((await readPrivateText(source.path))?.revision !== source.revision) {
      throw new Error(`Environment source changed during provisioning: ${source.path}`);
    }
  }
}

export function layeredDefinition(
  base: DevcontainerDefinition,
  layers: EnvironmentLayers,
): DevcontainerDefinition {
  return applyProjectEnvironment(base, layers.projectEnvironment);
}
