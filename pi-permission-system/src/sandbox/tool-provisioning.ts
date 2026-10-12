import { join } from "node:path";
import {
  equippedBaseRecipe,
  projectImageRecipe,
  type GeneratedImageRecipe,
  type ToolArtifactImage,
} from "./tool-assembly.ts";
import { nativeToolDependencies, toolArtifactRecipe } from "./tool-artifacts.ts";
import {
  buildContentKey,
  ensureCachedImage,
  equippedBaseKey,
  projectImageKey,
  toolArtifactKey,
} from "./tool-cache.ts";
import { resolveToolPlatform, toolPlatformKey, type ToolPlatform } from "./tool-platform.ts";
import { validateEnvironmentSources, type EnvironmentLayers } from "./environment-layers.ts";
import type { ImageToolInstallation } from "./image-tool-recipe.ts";

import { toolInventorySchema, type ToolInventory } from "./tool-inventory.ts";
export { toolInventorySchema, type ToolInventory } from "./tool-inventory.ts";

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
  copyMode: "linked" | "ordinary";
  ports: ToolBuildPorts;
  signal?: AbortSignal;
  report?: (text: string) => void;
}): Promise<{ imageId: string; inventory: ToolInventory }> {
  const platform = resolveToolPlatform(options.platform);
  const platformKey = toolPlatformKey(platform);
  const installationIds = new Set(options.layers.tools.map((tool) => tool.id));
  for (const installation of options.layers.projectEnvironment.installations) {
    if (installationIds.has(installation.id)) {
      throw new Error(`Duplicate installation ID across profiles and project environment: ${installation.id}`);
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
  const equippedRecipe = equippedBaseRecipe({
    baseImageId: options.baseImageId,
    imageUser: options.imageUser,
    artifacts,
    nativeDependenciesScript,
    copyMode: options.copyMode,
  });
  const equipped = await ensureCachedImage({
    directory: join(options.cacheDirectory, "images"),
    kind: "equipped",
    key: equippedBaseKey({
      baseImageId: options.baseImageId,
      platformKey,
      nativeDependenciesRevision: buildContentKey(nativeDependenciesScript),
      artifactImageIds: artifacts.map((artifact) => artifact.imageId),
      assemblyRevision: buildContentKey(equippedRecipe),
      copyMode: options.copyMode,
    }),
    signal: options.signal,
    report: options.report,
    ports: {
      inspect: options.ports.inspect,
      build: (name, signal) => options.ports.build(equippedRecipe, name, signal),
      verify: options.ports.validateImage,
    },
  });
  const project = options.layers.projectEnvironment;
  const installations = [...customInstallations, ...project.installations];
  const installedIds = new Set(inventoryEntries.map((tool) => tool.id));
  for (const installation of installations) {
    if (installedIds.has(installation.id)) {
      throw new Error(`Duplicate installation ID across profiles and project environment: ${installation.id}`);
    }
    installedIds.add(installation.id);
  }
  let imageId = equipped.imageId;
  if (installations.length || Object.keys(project.files).length) {
    const recipe = projectImageRecipe({
      equippedImageId: equipped.imageId,
      imageUser: options.imageUser,
      installations,
      companionFiles: project.files,
    });
    const built = await ensureCachedImage({
      directory: join(options.cacheDirectory, "images"),
      kind: "project",
      key: projectImageKey({
        equippedImageId: equipped.imageId,
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
  return { imageId, inventory };
}
