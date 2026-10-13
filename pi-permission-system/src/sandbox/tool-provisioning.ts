import { join } from "node:path";
import {
  infrastructureImageRecipe,
  projectImageRecipe,
  type GeneratedImageRecipe,
  type ToolArtifactImage,
} from "./tool-assembly.ts";
import { nativeToolDependencies, toolArtifactRecipe } from "./tool-artifacts.ts";
import {
  buildContentKey,
  ensureCachedImage,
  infrastructureImageKey,
  projectImageKey,
  toolArtifactKey,
} from "./tool-cache.ts";
import { resolveToolPlatform, toolPlatformKey, type ToolPlatform } from "./tool-platform.ts";
import { validateEnvironmentSources, type EnvironmentLayers } from "./environment-layers.ts";
import type { ImageToolInstallation } from "./image-tool-recipe.ts";

import { toolInventorySchema, type ToolInventory } from "./tool-inventory.ts";
export { toolInventorySchema, type ToolInventory } from "./tool-inventory.ts";
import {
  toolImageMount,
  SavedToolArtifactUnavailableError,
  validateToolImageInventory,
  type ToolImageMount,
} from "./tool-image-mounts.ts";

export interface ToolBuildPorts {
  inspect(imageId: string, signal?: AbortSignal): Promise<string | undefined>;
  build(recipe: GeneratedImageRecipe, name: string, signal?: AbortSignal): Promise<string>;
  validateImage(imageId: string, signal?: AbortSignal): Promise<void>;
  resolveBuilder(platform: ToolPlatform, signal?: AbortSignal): Promise<string>;
}

export async function provisionEnvironmentImage(options: {
  baseImageId: string;
  imageUser: string;
  platform: ToolPlatform;
  layers: EnvironmentLayers;
  cacheDirectory: string;
  ports: ToolBuildPorts;
  savedTools?: { inventory: ToolInventory; mounts: readonly ToolImageMount[] };
  signal?: AbortSignal;
  report?: (text: string) => void;
}): Promise<{ imageId: string; inventory: ToolInventory; toolImageMounts: ToolImageMount[] }> {
  const platform = resolveToolPlatform(options.platform);
  const platformKey = toolPlatformKey(platform);
  const savedTools = options.savedTools;
  if (savedTools) {
    validateToolImageInventory(savedTools.mounts, savedTools.inventory);
    if (savedTools.inventory.platform !== platformKey) {
      throw new Error("Saved tooling platform changed; approve a session rebuild");
    }
    const catalogEntries = options.layers.tools.filter((resolved) => resolved.catalog);
    if (
      catalogEntries.length !== savedTools.mounts.length ||
      catalogEntries.some(
        (resolved) =>
          !savedTools.mounts.some(
            (mount) => mount.toolId === resolved.id && mount.version === resolved.catalog!.version,
          ),
      )
    ) {
      throw new Error("Saved tooling differs from the definition; approve a session rebuild");
    }
    for (const mount of savedTools.mounts) {
      if ((await options.ports.inspect(mount.imageId, options.signal)) !== mount.imageId) {
        throw new SavedToolArtifactUnavailableError(
          mount,
          "Saved immutable image inspection failed",
        );
      }
      await options.ports.validateImage(mount.imageId, options.signal);
    }
  }
  const installationIds = new Set(options.layers.tools.map((tool) => tool.id));
  for (const installation of options.layers.projectEnvironment.installations) {
    if (installationIds.has(installation.id)) {
      throw new Error(
        `Duplicate installation ID across profiles and project environment: ${installation.id}`,
      );
    }
    installationIds.add(installation.id);
  }
  const builderImageId = await options.ports.resolveBuilder(platform, options.signal);
  const artifacts: ToolArtifactImage[] = [];
  const artifactById = new Map<string, ToolArtifactImage>();
  const inventoryEntries: ToolInventory["tools"] = [];
  const customInstallations: ImageToolInstallation[] = [];
  await validateEnvironmentSources(options.layers);
  for (const resolved of options.layers.tools) {
    options.signal?.throwIfAborted();
    if (resolved.entry.kind === "recipe") {
      customInstallations.push({
        id: resolved.id,
        version: resolved.entry.version,
        executable: resolved.entry.executable,
        command: resolved.entry.command,
        environment: resolved.entry.environment,
        prerequisites: resolved.entry.prerequisites,
      });
      continue;
    }
    const tool = resolved.catalog;
    if (!tool) {
      throw new Error(`Missing resolved catalog entry: ${resolved.id}`);
    }
    if (savedTools) {
      const savedInventoryEntry = savedTools.inventory.tools.find((entry) => entry.id === tool.id);
      if (!savedInventoryEntry) {
        throw new Error(`Saved tool inventory entry unavailable: ${tool.id}`);
      }
      inventoryEntries.push(savedInventoryEntry);
      continue;
    }
    const dependencies = resolved.dependencies.map((id) => {
      const artifact = artifactById.get(id);
      if (!artifact) {
        throw new Error(`Artifact dependency is not built: ${id}`);
      }
      return artifact;
    });
    const recipe = toolArtifactRecipe({ tool, platform, builderImageId, dependencies });
    const key = toolArtifactKey({
      toolId: tool.id,
      version: tool.version,
      platformKey,
      builderImageId,
      recipe: recipe.containerfile,
      files: recipe.files,
      dependencyImageIds: Object.fromEntries(
        dependencies.map((dependency) => [dependency.tool.id, dependency.imageId]),
      ),
    });
    const built = await ensureCachedImage({
      directory: join(options.cacheDirectory, "images"),
      kind: "artifact",
      key,
      signal: options.signal,
      report: options.report,
      ports: {
        inspect: options.ports.inspect,
        build: (name, signal) => options.ports.build(recipe, name, signal),
        verify: options.ports.validateImage,
      },
    });
    const artifact = { tool, imageId: built.imageId };
    artifacts.push(artifact);
    artifactById.set(tool.id, artifact);
    inventoryEntries.push({
      id: tool.id,
      version: tool.version,
      executable: tool.executable,
      source: resolved.source,
      imageId: built.imageId,
    });
  }
  const nativeDependenciesScript = nativeToolDependencies(platform);
  const infrastructureRecipe = infrastructureImageRecipe({
    baseImageId: options.baseImageId,
    imageUser: options.imageUser,
    nativeDependenciesScript,
  });
  const infrastructure = await ensureCachedImage({
    directory: join(options.cacheDirectory, "images"),
    kind: "infrastructure",
    key: infrastructureImageKey({
      baseImageId: options.baseImageId,
      platformKey,
      nativeDependenciesRevision: buildContentKey(nativeDependenciesScript),
      assemblyRevision: buildContentKey(infrastructureRecipe),
    }),
    signal: options.signal,
    report: options.report,
    ports: {
      inspect: options.ports.inspect,
      build: (name, signal) => options.ports.build(infrastructureRecipe, name, signal),
      verify: options.ports.validateImage,
    },
  });
  const project = options.layers.projectEnvironment;
  const installations = [...customInstallations, ...project.installations];
  const installedIds = new Set(inventoryEntries.map((tool) => tool.id));
  for (const installation of installations) {
    if (installedIds.has(installation.id)) {
      throw new Error(
        `Duplicate installation ID across profiles and project environment: ${installation.id}`,
      );
    }
    installedIds.add(installation.id);
  }
  let imageId = infrastructure.imageId;
  if (installations.length || Object.keys(project.files).length) {
    const recipe = projectImageRecipe({
      infrastructureImageId: infrastructure.imageId,
      imageUser: options.imageUser,
      installations,
      companionFiles: project.files,
    });
    const built = await ensureCachedImage({
      directory: join(options.cacheDirectory, "images"),
      kind: "project",
      key: projectImageKey({
        infrastructureImageId: infrastructure.imageId,
        recipe: recipe.containerfile,
        files: recipe.files,
      }),
      signal: options.signal,
      report: options.report,
      ports: {
        inspect: options.ports.inspect,
        build: (name, signal) => options.ports.build(recipe, name, signal),
        verify: options.ports.validateImage,
      },
    });
    imageId = built.imageId;
  }
  for (const tool of installations) {
    const source =
      options.layers.tools.find((resolved) => resolved.id === tool.id)?.source ?? "project";
    inventoryEntries.push({
      id: tool.id,
      version: tool.version,
      executable: tool.executable,
      source,
      imageId,
    });
  }
  await validateEnvironmentSources(options.layers);
  const inventory = toolInventorySchema.parse({
    version: 1,
    revision: buildContentKey({ platformKey, tools: inventoryEntries }),
    platform: platformKey,
    tools: inventoryEntries,
  });
  let toolImageMounts: ToolImageMount[];
  if (savedTools) {
    toolImageMounts = [...savedTools.mounts];
  } else {
    toolImageMounts = artifacts.map((artifact) => toolImageMount(artifact.tool, artifact.imageId));
  }
  validateToolImageInventory(toolImageMounts, inventory);
  return { imageId, inventory, toolImageMounts };
}
