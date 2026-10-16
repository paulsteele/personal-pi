import type { SandboxSession } from "./session.ts";
import type { MountGrant } from "./mounts.ts";
import type { VolumeGrant } from "./volumes.ts";
import { canonicalPath } from "./storage.ts";
import { guestToHost, hostToGuest, validateMountIdentity } from "./mounts.ts";
import {
  planImageTools,
  type ImageToolInstallation,
  type ImageToolsProposal,
} from "./image-tools.ts";

export const SANDBOX_SERVICE_CHANNEL = "sandbox:service:v1";
export interface SandboxService {
  version: 1;
  sessionId: string;
  session: SandboxSession;
  hostPath(guestPath: string): Promise<string | undefined>;
  guestPath(hostPath: string): Promise<string | undefined>;
  authorizeHostSource(hostPath: string, signal?: AbortSignal): Promise<void>;
  authorizeHostSources(hostPaths: readonly string[], signal?: AbortSignal): Promise<string[]>;
  revision(): string;
  planImageTools(
    tools: ImageToolInstallation[],
    signal: AbortSignal,
  ): Promise<ImageToolsProposal | undefined>;
}

export function createSandboxService(session: SandboxSession): SandboxService {
  let canonicalSourcePathProbeLock = Promise.resolve();
  const probeCanonicalSourcePaths = async (guestPaths: string[], signal?: AbortSignal) => {
    const previousProbeTurn = canonicalSourcePathProbeLock;
    let release!: () => void;
    canonicalSourcePathProbeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previousProbeTurn;
      signal?.throwIfAborted();
      return await session.filesystem.canonicalPaths(guestPaths, signal);
    } finally {
      release();
    }
  };
  const authorizeHostSources = (hostPaths: readonly string[], signal?: AbortSignal) => {
    if (!session.environment.container) {
      throw new Error("Sandbox source authorization requires a ready container");
    }
    return authorizeMappedSources({
      hostPaths,
      mounts: session.mounts,
      volumes: session.volumes,
      revision: () => session.revision,
      canonicalPaths: probeCanonicalSourcePaths,
      signal,
    });
  };
  return {
    version: 1,
    sessionId: session.options.sessionId,
    session,
    async hostPath(path) {
      const canonical = await session.filesystem.canonical(path);
      return guestToHost(canonical, session.mounts, session.volumes);
    },
    async guestPath(path) {
      return hostToGuest(path, session.mounts, session.volumes);
    },
    authorizeHostSources,
    async authorizeHostSource(path, signal) {
      await authorizeHostSources([path], signal);
    },
    revision: () => session.revision,
    planImageTools: (tools, signal) => planImageTools(session, tools, signal),
  };
}

export async function authorizeMappedSources(options: {
  hostPaths: readonly string[];
  mounts: readonly MountGrant[];
  volumes?: readonly VolumeGrant[];
  revision(): string;
  canonicalPaths(paths: string[], signal?: AbortSignal): Promise<string[]>;
  signal?: AbortSignal;
}): Promise<string[]> {
  options.signal?.throwIfAborted();
  const authorityRevision = options.revision();
  const canonicalHostPaths = await Promise.all(options.hostPaths.map(canonicalPath));
  const mappedGuestPaths = canonicalHostPaths.map((canonicalHostPath) => {
    const guestPath = hostToGuest(canonicalHostPath, options.mounts, options.volumes);
    if (!guestPath) {
      throw new Error(`Host source is outside approved sandbox mounts: ${canonicalHostPath}`);
    }
    return guestPath;
  });
  for (const grant of options.mounts) {
    await validateMountIdentity(grant);
  }
  const canonicalGuestPaths = await options.canonicalPaths(mappedGuestPaths, options.signal);
  if (canonicalGuestPaths.length !== canonicalHostPaths.length) {
    throw new Error("Guest source probe returned an incomplete path mapping");
  }
  if (options.revision() !== authorityRevision) {
    throw new Error("Sandbox authority changed during source authorization; retry");
  }
  for (const [index, canonicalGuestPath] of canonicalGuestPaths.entries()) {
    const mappedHostPath = guestToHost(canonicalGuestPath, options.mounts, options.volumes);
    if (mappedHostPath !== canonicalHostPaths[index]) {
      throw new Error(
        `Source symlink does not resolve to its approved host path: ${options.hostPaths[index]}`,
      );
    }
  }
  options.signal?.throwIfAborted();
  return canonicalGuestPaths;
}

export function discoverSandboxService(events: {
  emit(channel: string, value: unknown): void;
}): SandboxService {
  let service: SandboxService | undefined;
  const acceptService = (value: SandboxService) => {
    service = value;
  };
  events.emit(SANDBOX_SERVICE_CHANNEL, { version: 1, accept: acceptService });
  if (!service) {
    throw new Error("Mandatory sandbox service is unavailable");
  }
  return service;
}
