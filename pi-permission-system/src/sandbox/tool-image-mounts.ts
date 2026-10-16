import { posix } from "node:path";
import { z } from "zod";
import {
  catalogTool,
  catalogToolPrefix,
  STANDARD_TOOL_CATALOG,
  type CatalogTool,
} from "./tool-catalog.ts";
import type { ToolInventory } from "./tool-inventory.ts";
import type { ToolEngineOutput } from "./tool-build-runtime.ts";

export const toolImageMountSchema = z
  .strictObject({
    toolId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(100),
    version: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .max(100),
    imageId: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
    subpath: z.string(),
    destination: z.string(),
    readOnly: z.literal(true),
  })
  .superRefine((mount, context) => {
    const prefix = catalogToolPrefix({ id: mount.toolId, version: mount.version });
    if (mount.subpath !== prefix || mount.destination !== prefix) {
      context.addIssue({
        code: "custom",
        message: "Tool image mount must use its exact versioned catalog prefix",
      });
    }
  });
export class SavedToolArtifactUnavailableError extends Error {
  constructor(mount: ToolImageMount, cause: unknown) {
    super(
      `Saved tool artifact unavailable: ${mount.toolId}@${mount.version} (${mount.imageId}). Restore this immutable image or approve a session rebuild; saved state was not discarded.`,
      { cause },
    );
    this.name = "SavedToolArtifactUnavailableError";
  }
}

export type ToolImageMount = z.output<typeof toolImageMountSchema>;
export const toolImageMountsSchema = z
  .array(toolImageMountSchema)
  .max(64)
  .superRefine((mounts, context) => {
    const ids = new Set<string>();
    for (const mount of mounts) {
      if (ids.has(mount.toolId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate tool image mount: ${mount.toolId}`,
        });
      }
      ids.add(mount.toolId);
    }
  });

export const inspectedToolMountSchema = z.looseObject({
  Type: z.string(),
  Name: z.string().optional(),
  Source: z.string(),
  Destination: z.string(),
  RW: z.boolean(),
  SubPath: z.string().optional(),
  Options: z.array(z.string()).nullable().optional(),
  Propagation: z.string().optional(),
});
export type InspectedToolMount = z.output<typeof inspectedToolMountSchema>;

const readOnlyOverlayFlags = new Set(["userxattr"]);

function isOwnedReadOnlyImageBacking(
  mount: InspectedToolMount,
  containerId: string,
  staticDir: string,
): boolean {
  const overlayDirectory = `${staticDir}/overlay/`;
  const overlaySuffix = mount.Source.slice(overlayDirectory.length);
  const lowerDirectory = mount.Source.replace(/\/merge$/, "/lower");
  const [lowerDirectoryOption, ...additionalOptions] = mount.Options ?? [];
  const lowerDirectories = lowerDirectoryOption?.replace(/^lowerdir=/, "").split(":");
  const subpathDirectory = lowerDirectories?.[0];
  const containerRunPath = `/overlay-containers/${containerId}/userdata/subpath`;
  const subpathSuffix = subpathDirectory?.split(containerRunPath);
  return (
    mount.Type === "bind" &&
    mount.Propagation === "private" &&
    mount.Source.startsWith(overlayDirectory) &&
    /^\d+\/merge$/.test(overlaySuffix) &&
    lowerDirectoryOption?.startsWith("lowerdir=") === true &&
    additionalOptions.every((option) => readOnlyOverlayFlags.has(option)) &&
    lowerDirectories?.length === 2 &&
    lowerDirectories[1] === lowerDirectory &&
    subpathSuffix?.length === 2 &&
    subpathSuffix[0]!.startsWith("/") &&
    /^\d+$/.test(subpathSuffix[1]!)
  );
}

export function consumeInspectedToolImageMounts(options: {
  mounts: readonly InspectedToolMount[];
  expected: readonly Pick<ToolImageMount, "imageId" | "subpath" | "destination">[];
  containerId: string;
  staticDir?: string;
}): InspectedToolMount[] {
  const remaining = [...options.mounts];
  for (const expected of options.expected) {
    const matching = remaining.filter((mount) => mount.Destination === expected.destination);
    const images = matching.filter((mount) => mount.Type === "image");
    const image = images[0];
    if (
      images.length !== 1 ||
      image?.Source !== expected.imageId ||
      image.SubPath !== expected.subpath ||
      image.RW
    ) {
      throw new Error(
        `Container inspection does not match tool image mount: ${expected.destination}`,
      );
    }
    const backing = matching.filter((mount) => mount.Type !== "image");
    const hasUnexpectedBacking =
      backing.length > 1 ||
      (backing.length === 1 &&
        (!options.staticDir ||
          !isOwnedReadOnlyImageBacking(backing[0]!, options.containerId, options.staticDir)));
    if (hasUnexpectedBacking) {
      throw new Error(`Container inspection has unexpected image backing: ${expected.destination}`);
    }
    for (const mount of matching) {
      remaining.splice(remaining.indexOf(mount), 1);
    }
  }
  return remaining;
}

export function toolImageMount(tool: CatalogTool, imageId: string): ToolImageMount {
  const prefix = catalogToolPrefix(tool);
  return toolImageMountSchema.parse({
    toolId: tool.id,
    version: tool.version,
    imageId,
    subpath: prefix,
    destination: prefix,
    readOnly: true,
  });
}

export function toolImageMountArgument(mount: ToolImageMount): string {
  const validated = toolImageMountSchema.parse(mount);
  return `type=image,source=${validated.imageId},subpath=${validated.subpath},destination=${validated.destination},rw=false`;
}

export function validateToolImageInventory(
  mounts: readonly ToolImageMount[],
  inventory: ToolInventory,
): void {
  toolImageMountsSchema.parse(mounts);
  const mountedIds = new Set(mounts.map((mount) => mount.toolId));
  for (const mount of mounts) {
    const tool = catalogTool(mount.toolId, mount.version);
    const entries = inventory.tools.filter((entry) => entry.id === mount.toolId);
    const entry = entries[0];
    const matchesInventory =
      entries.length === 1 &&
      entry?.version === mount.version &&
      entry.imageId === mount.imageId &&
      entry.executable === tool.executable;
    if (!matchesInventory) {
      throw new Error(`Tool image mount differs from inventory: ${mount.toolId}`);
    }
    for (const dependency of tool.dependencies) {
      if (!mountedIds.has(dependency)) {
        throw new Error(`Tool image mount is missing runtime dependency: ${dependency}`);
      }
    }
  }
  for (const entry of inventory.tools) {
    const isCatalogTool = STANDARD_TOOL_CATALOG.some((tool) => tool.id === entry.id);
    if (isCatalogTool && !mountedIds.has(entry.id)) {
      throw new Error(`Catalog inventory entry has no image mount: ${entry.id}`);
    }
  }
}

export async function verifyToolMountDestinations(options: {
  run: ToolEngineOutput;
  imageId: string;
  containerName: string;
  mounts: readonly ToolImageMount[];
  signal?: AbortSignal;
}): Promise<void> {
  const paths = new Set<string>();
  for (const mount of options.mounts) {
    toolImageMountSchema.parse(mount);
    for (let path = mount.destination; path !== "/"; path = posix.dirname(path)) {
      paths.add(path);
    }
  }
  if (paths.size === 0) {
    return;
  }
  const script = [
    "set -eu",
    "for path do",
    '  if test -L "$path" || { test -e "$path" && ! test -d "$path"; }; then',
    '    printf "Unsafe tool image mount destination: %s\\n" "$path" >&2',
    "    exit 1",
    "  fi",
    "done",
  ].join("\n");
  try {
    await options.run(
      [
        "run",
        "--rm",
        "--pull=never",
        "--name",
        options.containerName,
        "--network=none",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user",
        "0",
        "--entrypoint",
        "/bin/sh",
        options.imageId,
        "-c",
        script,
        "sh",
        ...paths,
      ],
      AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(30_000)]),
    );
  } finally {
    await options.run(
      ["rm", "--force", "--time=0", "--ignore", options.containerName],
      AbortSignal.timeout(15_000),
    );
  }
}
