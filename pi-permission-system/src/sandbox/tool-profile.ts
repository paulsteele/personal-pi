import { join } from "node:path";
import { projectStoragePath, type ProjectLocation } from "@paulsteele/pi-project-locations";
import { parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import { z } from "zod";
import {
  catalogTool,
  REQUIRED_LANGUAGE_SERVERS,
  STANDARD_TOOL_CATALOG,
  type CatalogTool,
} from "./tool-catalog.ts";
import { imageToolInstallationSchema } from "./image-tool-recipe.ts";
import { sandboxStorageRoot } from "./settings.ts";
import { readPrivateText } from "./storage.ts";

const toolId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .max(100);
const catalogEntrySchema = z.strictObject({
  kind: z.literal("catalog"),
  version: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .max(100),
});
const recipeEntrySchema = imageToolInstallationSchema.omit({ id: true }).extend({
  kind: z.literal("recipe"),
  dependencies: z.array(toolId).max(32).default([]),
});
export const toolProfileSchema = z.strictObject({
  version: z.literal(1),
  tools: z.record(toolId, z.discriminatedUnion("kind", [catalogEntrySchema, recipeEntrySchema])),
  exclude: z.array(toolId).max(64).default([]),
});

export type ToolProfile = z.output<typeof toolProfileSchema>;
export type ToolProfileEntry = ToolProfile["tools"][string];
export interface ResolvedTool {
  id: string;
  source: "global" | "project";
  entry: ToolProfileEntry;
  dependencies: readonly string[];
  catalog?: CatalogTool;
}
export interface StoredToolProfile {
  path: string;
  revision: string;
  profile: ToolProfile;
}

function rejectDuplicateProperties(node: JsonNode): void {
  if (node.type === "object") {
    const names = new Set<string>();
    for (const property of node.children ?? []) {
      const name = property.children?.[0]?.value as string;
      if (names.has(name)) {
        throw new Error(`Duplicate configuration property: ${name}`);
      }
      names.add(name);
    }
  }
  for (const child of node.children ?? []) {
    rejectDuplicateProperties(child);
  }
}

export function parseUniqueJson(text: string): unknown {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!tree || errors.length) {
    throw new Error("Invalid private configuration JSON");
  }
  rejectDuplicateProperties(tree);
  return JSON.parse(text);
}

export function parseToolProfile(value: unknown): ToolProfile {
  const profile = toolProfileSchema.parse(value);
  if (Object.keys(profile.tools).length > 64) {
    throw new Error("A tool profile may contain at most 64 tools");
  }
  if (new Set(profile.exclude).size !== profile.exclude.length) {
    throw new Error("Duplicate excluded tool");
  }
  for (const id of profile.exclude) {
    if (REQUIRED_LANGUAGE_SERVERS.includes(id)) {
      throw new Error(`Required language server cannot be excluded: ${id}`);
    }
    if (Object.hasOwn(profile.tools, id)) {
      throw new Error(`Tool is both declared and excluded: ${id}`);
    }
  }
  return profile;
}

export function defaultToolProfile(): ToolProfile {
  return {
    version: 1,
    tools: Object.fromEntries(
      STANDARD_TOOL_CATALOG.map((tool) => [tool.id, { kind: "catalog", version: tool.version }]),
    ),
    exclude: [],
  };
}

export function globalToolProfilePath(agentDir: string): string {
  return join(sandboxStorageRoot(agentDir), "global", "tools.json");
}

export function projectToolProfilePath(agentDir: string, project: ProjectLocation): string {
  return projectStoragePath(sandboxStorageRoot(agentDir), project, "devcontainer/tools.json");
}

export async function loadToolProfile(path: string): Promise<StoredToolProfile | undefined> {
  const stored = await readPrivateText(path);
  if (!stored) {
    return undefined;
  }
  return {
    path,
    revision: stored.revision,
    profile: parseToolProfile(parseUniqueJson(stored.text)),
  };
}

export function resolveToolProfiles(
  global: ToolProfile,
  project?: ToolProfile,
  catalog: readonly CatalogTool[] = STANDARD_TOOL_CATALOG,
): ResolvedTool[] {
  const resolvedToolsById = new Map<string, ResolvedTool>();
  const profileLayers = [
    { source: "global" as const, profile: global },
    { source: "project" as const, profile: project },
  ];
  for (const profileLayer of profileLayers) {
    if (!profileLayer.profile) {
      continue;
    }
    const profile = parseToolProfile(profileLayer.profile);
    for (const id of profile.exclude) {
      if (!resolvedToolsById.delete(id)) {
        throw new Error(`Cannot exclude undeclared tool: ${id}`);
      }
    }
    for (const [id, entry] of Object.entries(profile.tools)) {
      const catalogEntry =
        entry.kind === "catalog" ? catalogTool(id, entry.version, catalog) : undefined;
      if (entry.kind === "recipe" && catalog.some((tool) => tool.id === id)) {
        throw new Error(`Managed tool requires a verified catalog recipe: ${id}`);
      }
      resolvedToolsById.set(id, {
        id,
        source: profileLayer.source,
        entry,
        dependencies:
          catalogEntry?.dependencies ?? (entry.kind === "recipe" ? entry.dependencies : []),
        ...(catalogEntry ? { catalog: catalogEntry } : {}),
      });
    }
  }
  for (const id of REQUIRED_LANGUAGE_SERVERS) {
    if (!resolvedToolsById.has(id)) {
      throw new Error(`Global tooling must include language server: ${id}`);
    }
  }
  const ordered: ResolvedTool[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function appendDependenciesFirst(id: string): void {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error(`Tool dependency cycle includes ${id}`);
    }
    const tool = resolvedToolsById.get(id);
    if (!tool) {
      throw new Error(`Missing tool dependency: ${id}`);
    }
    visiting.add(id);
    for (const dependency of [...tool.dependencies].sort()) {
      appendDependenciesFirst(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(tool);
  }
  for (const id of [...resolvedToolsById.keys()].sort()) {
    appendDependenciesFirst(id);
  }
  return ordered;
}
