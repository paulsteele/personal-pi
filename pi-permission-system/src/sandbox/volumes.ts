import { z } from "zod";
import { projectEngineSlug } from "./container-identity.ts";
import { type MountGrant, validateMountDestination } from "./mounts.ts";
import { isPathInside, sha256Hex } from "./storage.ts";
import type { ToolEngineOutput } from "./tool-build-runtime.ts";

export const projectVolumeLabel = "pi.sandbox.volume";
export const projectVolumeRootLabel = "pi.sandbox.project-root";

export const volumeGrantSchema = z
  .object({
    name: z.string().regex(/^pi-vol-[a-z0-9_.-]+-[a-f0-9]{16}$/),
    destination: z.string().min(1).max(4096),
    access: z.enum(["ro", "rw"]),
  })
  .strict();
export type VolumeGrant = z.output<typeof volumeGrantSchema>;

export function projectVolumeName(projectRoot: string, destination: string): string {
  const checkoutDestinationKey = sha256Hex(`${projectRoot}\0${destination}`).slice(0, 16);
  return `pi-vol-${projectEngineSlug(projectRoot)}-${checkoutDestinationKey}`;
}

export function projectVolumeGrant(options: {
  projectRoot: string;
  destination: string;
  access: "ro" | "rw";
}): VolumeGrant {
  validateMountDestination(options.destination);
  return {
    name: projectVolumeName(options.projectRoot, options.destination),
    destination: options.destination,
    access: options.access,
  };
}

export function volumeMountArgument(volume: VolumeGrant): string {
  return `type=volume,source=${volume.name},target=${volume.destination}${volume.access === "ro" ? ",readonly" : ""}`;
}

export function validateVolumeTopology(
  binds: readonly MountGrant[],
  volumes: readonly VolumeGrant[],
): void {
  for (const [index, volume] of volumes.entries()) {
    validateMountDestination(volume.destination);
    for (const other of volumes.slice(0, index)) {
      const overlappingVolumes =
        isPathInside(volume.destination, other.destination) ||
        isPathInside(other.destination, volume.destination);
      if (overlappingVolumes) {
        throw new Error(
          `Conflicting volume destinations: ${volume.destination} and ${other.destination}`,
        );
      }
    }
    for (const bind of binds) {
      const bindIsShadowedByVolume = isPathInside(volume.destination, bind.destination);
      if (bindIsShadowedByVolume) {
        throw new Error(
          `Host bind ${bind.destination} cannot be nested inside volume ${volume.destination}`,
        );
      }
    }
  }
}

const volumeInspectionSchema = z.array(
  z.looseObject({
    Name: z.string(),
    Labels: z.record(z.string(), z.string()).nullable().optional(),
  }),
);

export async function ensureProjectVolume(options: {
  run: ToolEngineOutput;
  volume: VolumeGrant;
  projectRoot: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { run, volume, projectRoot, signal } = options;
  const labeledVolumeNames = (
    await run(
      ["volume", "ls", "--filter", `label=${projectVolumeLabel}=1`, "--format", "{{.Name}}"],
      signal,
    )
  )
    .split(/\s+/)
    .filter(Boolean);
  if (!labeledVolumeNames.includes(volume.name)) {
    await run(
      [
        "volume",
        "create",
        "--label",
        `${projectVolumeLabel}=1`,
        "--label",
        `${projectVolumeRootLabel}=${projectRoot}`,
        volume.name,
      ],
      signal,
    );
    return;
  }
  const [existing] = volumeInspectionSchema.parse(
    JSON.parse(await run(["volume", "inspect", volume.name], signal)),
  );
  const belongsToCheckout =
    existing?.Name === volume.name && existing.Labels?.[projectVolumeRootLabel] === projectRoot;
  if (!belongsToCheckout) {
    throw new Error(`Sandbox volume ${volume.name} belongs to another checkout`);
  }
}
