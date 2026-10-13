import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  ensurePrivateDirectory,
  publishPrivateText,
  readPrivateText,
  sha256Hex,
  withPrivateLock,
} from "./storage.ts";

function canonicalCacheValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalCacheValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalCacheValue(entry)]),
    );
  }
  return value;
}

export function buildContentKey(value: unknown): string {
  return sha256Hex(JSON.stringify(canonicalCacheValue(value)));
}

export interface ToolArtifactInput {
  toolId: string;
  version: string;
  platformKey: string;
  builderImageId: string;
  recipe: string;
  files: Record<string, string>;
  dependencyImageIds: Record<string, string>;
}

export function toolArtifactKey(input: ToolArtifactInput): string {
  return buildContentKey({
    kind: "tool-artifact-v1",
    toolId: input.toolId,
    version: input.version,
    platformKey: input.platformKey,
    builderImageId: input.builderImageId,
    recipe: input.recipe,
    files: input.files,
    dependencyImageIds: input.dependencyImageIds,
  });
}

export function infrastructureImageKey(input: {
  baseImageId: string;
  platformKey: string;
  nativeDependenciesRevision: string;
  assemblyRevision: string;
}): string {
  return buildContentKey({
    kind: "infrastructure-image-v1",
    baseImageId: input.baseImageId,
    platformKey: input.platformKey,
    nativeDependenciesRevision: input.nativeDependenciesRevision,
    assemblyRevision: input.assemblyRevision,
  });
}

export function projectImageKey(input: {
  infrastructureImageId: string;
  recipe: string;
  files: Record<string, string>;
}): string {
  return buildContentKey({ kind: "project-image-v2", ...input });
}

const cachedImageSchema = z.strictObject({
  version: z.literal(1),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  imageId: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
});

export async function withBuildLock<T>(
  path: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + 7_200_000;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await withPrivateLock(path, operation);
    } catch (error) {
      const isLockConflict = String(error).includes(`Sandbox operation owns ${path};`);
      if (!isLockConflict || Date.now() >= deadline) {
        throw error;
      }
      await sleep(250, undefined, { signal });
    }
  }
}

export interface CachedBuildPorts {
  inspect(imageId: string, signal?: AbortSignal): Promise<string | undefined>;
  build(imageName: string, signal?: AbortSignal): Promise<string>;
  verify(imageId: string, signal?: AbortSignal): Promise<void>;
}

export async function ensureCachedImage(options: {
  directory: string;
  kind: "artifact" | "infrastructure" | "project";
  key: string;
  ports: CachedBuildPorts;
  signal?: AbortSignal;
  report?: (message: string) => void;
}): Promise<{ imageId: string; reused: boolean }> {
  if (!/^[a-f0-9]{64}$/.test(options.key)) {
    throw new Error("Invalid image cache key");
  }
  options.signal?.throwIfAborted();
  await ensurePrivateDirectory(options.directory);
  const recordPath = join(options.directory, `${options.kind}-${options.key}.json`);
  return withBuildLock(`${recordPath}.build.lock`, options.signal, async () => {
    options.signal?.throwIfAborted();
    const stored = await readPrivateText(recordPath);
    if (stored) {
      const record = cachedImageSchema.parse(JSON.parse(stored.text));
      if (record.key !== options.key) {
        throw new Error("Image cache record has a different build identity");
      }
      const inspectedId = await options.ports.inspect(record.imageId, options.signal);
      if (inspectedId === record.imageId) {
        await options.ports.verify(record.imageId, options.signal);
        options.report?.(`Reusing ${options.kind} image ${record.imageId}`);
        return { imageId: record.imageId, reused: true };
      }
    }
    const imageName = `localhost/pi-${options.kind}:${options.key}`;
    options.report?.(`Building ${options.kind} image ${imageName}`);
    const imageId = await options.ports.build(imageName, options.signal);
    const record = cachedImageSchema.parse({ version: 1, key: options.key, imageId });
    if ((await options.ports.inspect(imageId, options.signal)) !== imageId) {
      throw new Error("Built image identity could not be verified");
    }
    await options.ports.verify(imageId, options.signal);
    options.signal?.throwIfAborted();
    await publishPrivateText(recordPath, `${JSON.stringify(record)}\n`, stored?.revision);
    return { imageId, reused: false };
  });
}
