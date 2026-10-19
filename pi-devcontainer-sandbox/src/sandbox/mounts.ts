import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
import { z } from "zod";
import { isPathInside } from "./storage.ts";
import type { VolumeGrant } from "./volumes.ts";

export const mountGrantSchema = z
  .object({
    source: z.string().min(1).max(4096),
    destination: z.string().min(1).max(4096),
    access: z.enum(["ro", "rw"]),
    identity: z.string().min(1),
    kind: z.enum(["file", "directory"]),
  })
  .strict();
export type MountGrant = z.output<typeof mountGrantSchema>;

const protectedGuestRoots = [
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/run/pi-sandbox",
  "/opt/pi-tools",
];

export function validateMountDestination(destination: string): void {
  if (
    !posix.isAbsolute(destination) ||
    destination === "/" ||
    destination.includes("\0") ||
    destination.includes(",") ||
    posix.normalize(destination) !== destination
  ) {
    throw new Error("Mount destination must be an absolute normalized guest path");
  }
  if (
    protectedGuestRoots.some(
      (root) => isPathInside(root, destination) || isPathInside(destination, root),
    )
  ) {
    throw new Error(`Mount destination overlaps a protected guest root: ${destination}`);
  }
}

export async function createMountGrant(options: {
  path: string;
  destination?: string;
  access: "ro" | "rw";
  privateStorage: string;
}): Promise<MountGrant> {
  if (!isAbsolute(options.path) || options.path.includes("\0") || options.path.includes(",")) {
    throw new Error("Host mount source must be an absolute path without mount delimiters");
  }
  const source = await realpath(options.path);
  const storage = await realpath(options.privateStorage);
  if (isPathInside(storage, source) || isPathInside(source, storage)) {
    throw new Error("Host mount would expose private sandbox authority storage");
  }
  const stat = await lstat(source, { bigint: true });
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(
      "Only regular files and directories can be mounted; sockets/devices are forbidden",
    );
  }
  const destination = options.destination ?? source;
  validateMountDestination(destination);
  return {
    source,
    destination,
    access: options.access,
    identity: `${stat.dev}:${stat.ino}`,
    kind: stat.isDirectory() ? "directory" : "file",
  };
}

export class ReplacedMountSourceError extends Error {
  constructor(source: string) {
    super(`Host mount source was replaced: ${source}`);
    this.name = "ReplacedMountSourceError";
  }
}

export async function validateMountIdentity(grant: MountGrant): Promise<void> {
  if ((await realpath(grant.source)) !== grant.source) {
    throw new Error(`Host source no longer has its approved canonical path: ${grant.source}`);
  }
  const stat = await lstat(grant.source, { bigint: true });
  if (grant.kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(`Host mount source changed kind: ${grant.source}`);
  }
  if (`${stat.dev}:${stat.ino}` !== grant.identity) {
    throw new ReplacedMountSourceError(grant.source);
  }
}

export async function reapproveReplacedMounts(options: {
  mounts: readonly MountGrant[];
  privateStorage: string;
  confirm: (preview: string, signal: AbortSignal) => Promise<boolean>;
  signal: AbortSignal;
}): Promise<MountGrant[]> {
  const mounts: MountGrant[] = [];
  for (const approved of options.mounts) {
    options.signal.throwIfAborted();
    try {
      await validateMountIdentity(approved);
      mounts.push(approved);
      continue;
    } catch (error) {
      if (!(error instanceof ReplacedMountSourceError)) {
        throw error;
      }
    }
    const replacement = await createMountGrant({
      path: approved.source,
      destination: approved.destination,
      access: approved.access,
      privateStorage: options.privateStorage,
    });
    if (replacement.source !== approved.source || replacement.kind !== approved.kind) {
      throw new Error(`Host mount source changed path or kind: ${approved.source}`);
    }
    const preview = [
      "A previously approved host mount source was replaced. Reapprove the replacement?",
      `Source: ${replacement.source}`,
      `Destination: ${replacement.destination}`,
      `Access: ${replacement.access}`,
      `Kind: ${replacement.kind}`,
      `Previous identity: ${approved.identity}`,
      `Replacement identity: ${replacement.identity}`,
      "The devcontainer will be recreated; container-local changes will be checkpointed.",
    ].join("\n");
    if (!(await options.confirm(preview, options.signal))) {
      throw new Error(`Replacement host mount was not approved: ${approved.source}`);
    }
    options.signal.throwIfAborted();
    mounts.push(replacement);
  }
  for (const mount of mounts) {
    await validateMountIdentity(mount);
  }
  return mounts;
}

export function validateMountTopology(grants: readonly MountGrant[]): void {
  for (const [index, grant] of grants.entries()) {
    validateMountDestination(grant.destination);
    for (const other of grants.slice(0, index)) {
      const overlappingDestinations =
        isPathInside(grant.destination, other.destination) ||
        isPathInside(other.destination, grant.destination);
      if (overlappingDestinations) {
        throw new Error(
          `Conflicting mount destinations: ${grant.destination} and ${other.destination}`,
        );
      }
    }
  }
}

export function isGuestPathInVolume(path: string, volumes: readonly VolumeGrant[]): boolean {
  const normalizedPath = posix.normalize(path);
  return volumes.some((volume) => isPathInside(volume.destination, normalizedPath));
}

export function guestToHost(
  path: string,
  grants: readonly MountGrant[],
  volumes: readonly VolumeGrant[] = [],
): string | undefined {
  if (isGuestPathInVolume(path, volumes)) {
    return undefined;
  }
  const grant = grants.find((candidate) => {
    const matchesDestination =
      candidate.kind === "file"
        ? path === candidate.destination
        : isPathInside(candidate.destination, path);
    return matchesDestination;
  });
  return grant ? posix.join(grant.source, posix.relative(grant.destination, path)) : undefined;
}

export function hostToGuest(
  path: string,
  grants: readonly MountGrant[],
  volumes: readonly VolumeGrant[] = [],
): string | undefined {
  const grant = grants.find((candidate) => {
    const matchesSource =
      candidate.kind === "file" ? path === candidate.source : isPathInside(candidate.source, path);
    return matchesSource;
  });
  if (!grant) {
    return undefined;
  }
  const guestPath = posix.join(grant.destination, posix.relative(grant.source, path));
  const hostPathIsShadowedByVolume = isGuestPathInVolume(guestPath, volumes);
  return hostPathIsShadowedByVolume ? undefined : guestPath;
}

export function mountArgument(grant: MountGrant): string {
  return `type=bind,source=${grant.source},target=${grant.destination}${grant.access === "ro" ? ",readonly" : ""}`;
}
