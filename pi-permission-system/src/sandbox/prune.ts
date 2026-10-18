import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { podmanOutput } from "./driver.ts";
import {
  sessionHashPrefixOfImage,
  sessionImageHashPrefix,
  SESSION_IMAGE_REPOSITORY_PREFIX,
} from "./container-identity.ts";
import { acquireOwnerLock, hasLiveOwner } from "./owner-lock.ts";
import { sessionRecordSchema } from "./session-record.ts";
import { sandboxStorageRoot } from "./settings.ts";
import {
  publishPrivateText,
  readPrivateText,
  rejectStorageSymlinks,
  sha256Hex,
} from "./storage.ts";

export const inactiveSessionRetentionMs = 7 * 24 * 60 * 60 * 1000;

const sessionDirectoryPattern = /^[a-f0-9]{64}$/;
const containerIdPattern = /^[a-f0-9]{64}$/;

interface SessionContainer {
  id: string;
  sessionId: string;
}

const listedContainersSchema = z.array(
  z.looseObject({
    Id: z.string(),
    Labels: z.record(z.string(), z.string()).nullable().optional(),
  }),
);

interface SessionImage {
  reference: string;
  sessionHashPrefix: string;
}

export async function removeSupersededContainer(
  previousContainer: string,
  replacementContainer: string,
  report: (text: string) => void,
): Promise<void> {
  if (previousContainer === replacementContainer) {
    return;
  }
  try {
    await podmanOutput(["rm", previousContainer]);
  } catch (error) {
    report(
      `Could not remove superseded sandbox container ${previousContainer}: ${String(error)}\n`,
    );
  }
}

async function listSessionContainers(): Promise<SessionContainer[]> {
  const output = await podmanOutput([
    "ps",
    "--all",
    "--no-trunc",
    "--filter",
    "label=pi.sandbox.session",
    "--format",
    "json",
  ]);
  const containers: SessionContainer[] = [];
  for (const listed of listedContainersSchema.parse(JSON.parse(output || "[]"))) {
    const sessionId = listed.Labels?.["pi.sandbox.session"];
    if (sessionId && containerIdPattern.test(listed.Id)) {
      containers.push({ id: listed.Id, sessionId });
    }
  }
  return containers;
}

async function listSessionImages(): Promise<SessionImage[]> {
  const output = await podmanOutput([
    "images",
    "--filter",
    `reference=${SESSION_IMAGE_REPOSITORY_PREFIX}*`,
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ]);
  const images: SessionImage[] = [];
  for (const reference of output.split(/\s+/).filter(Boolean)) {
    const sessionHashPrefix = sessionHashPrefixOfImage(reference);
    if (sessionHashPrefix) {
      images.push({ reference, sessionHashPrefix });
    }
  }
  return images;
}

async function removeImages(
  images: readonly SessionImage[],
  report: (text: string) => void,
): Promise<void> {
  for (const image of images) {
    try {
      await podmanOutput(["rmi", image.reference]);
      report(`Removed unused sandbox image ${image.reference}.\n`);
    } catch (error) {
      report(`Could not remove sandbox image ${image.reference}: ${String(error)}\n`);
    }
  }
}

export async function removeSessionImages(
  sessionId: string,
  report: (text: string) => void,
): Promise<void> {
  const hashPrefix = sessionImageHashPrefix(sessionId);
  const images = await listSessionImages();
  await removeImages(
    images.filter((image) => image.sessionHashPrefix === hashPrefix),
    report,
  );
}

async function sessionDirectoryNames(sessionsDirectory: string): Promise<string[]> {
  const entries = await readdir(sessionsDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && sessionDirectoryPattern.test(entry.name))
    .map((entry) => entry.name);
}

async function liveSessionHashes(
  sessionsDirectory: string,
  sessionHashes: readonly string[],
): Promise<Set<string>> {
  const live = new Set<string>();
  for (const sessionHash of sessionHashes) {
    if (await hasLiveOwner(join(sessionsDirectory, sessionHash, "owner.lock"))) {
      live.add(sessionHash);
    }
  }
  return live;
}

async function markContainerDisposed(directory: string, nowUnixMs: number): Promise<void> {
  const lock = await acquireOwnerLock(join(directory, "owner.lock"));
  if (!lock) {
    return;
  }
  try {
    const recordPath = join(directory, "session.json");
    const stored = await readPrivateText(recordPath);
    if (!stored) {
      return;
    }
    const record = sessionRecordSchema.parse(JSON.parse(stored.text));
    if (record.containerPrunedAtUnixMs !== undefined) {
      return;
    }
    await publishPrivateText(
      recordPath,
      JSON.stringify({
        ...record,
        inactiveSinceUnixMs: record.inactiveSinceUnixMs ?? nowUnixMs,
        containerPrunedAtUnixMs: nowUnixMs,
      }),
      stored.revision,
    );
  } finally {
    await lock.release();
  }
}

async function removeAbandonedContainers(options: {
  sessionsDirectory: string;
  liveHashes: ReadonlySet<string>;
  nowUnixMs: number;
  report: (text: string) => void;
}): Promise<void> {
  const disposedSessionHashes = new Set<string>();
  for (const container of await listSessionContainers()) {
    const sessionHash = sha256Hex(container.sessionId);
    if (options.liveHashes.has(sessionHash)) {
      continue;
    }
    try {
      await podmanOutput(["rm", "--force", "--time=0", container.id]);
      disposedSessionHashes.add(sessionHash);
      options.report(`Removed abandoned sandbox container ${container.id.slice(0, 12)}.\n`);
    } catch (error) {
      options.report(`Could not remove sandbox container ${container.id}: ${String(error)}\n`);
    }
  }
  for (const sessionHash of disposedSessionHashes) {
    try {
      await markContainerDisposed(join(options.sessionsDirectory, sessionHash), options.nowUnixMs);
    } catch (error) {
      options.report(`Could not update sandbox session ${sessionHash}: ${String(error)}\n`);
    }
  }
}

async function removeAbandonedSessionImages(options: {
  liveHashes: ReadonlySet<string>;
  report: (text: string) => void;
}): Promise<void> {
  const liveHashes = [...options.liveHashes];
  const belongsToLiveSession = (image: SessionImage) =>
    liveHashes.some((hash) => hash.startsWith(image.sessionHashPrefix));
  const images = await listSessionImages();
  await removeImages(
    images.filter((image) => !belongsToLiveSession(image)),
    options.report,
  );
}

async function removeExpiredFailedStartDirectories(options: {
  sessionsDirectory: string;
  sessionHashes: readonly string[];
  liveHashes: ReadonlySet<string>;
  nowUnixMs: number;
  report: (text: string) => void;
}): Promise<void> {
  for (const sessionHash of options.sessionHashes) {
    if (options.liveHashes.has(sessionHash)) {
      continue;
    }
    const directory = join(options.sessionsDirectory, sessionHash);
    try {
      await rejectStorageSymlinks(directory);
      if (await readPrivateText(join(directory, "session.json"))) {
        continue;
      }
      const inactiveForMs = options.nowUnixMs - (await lstat(directory)).mtimeMs;
      if (inactiveForMs < inactiveSessionRetentionMs) {
        continue;
      }
      const lock = await acquireOwnerLock(join(directory, "owner.lock"));
      if (!lock) {
        continue;
      }
      await rm(directory, { recursive: true, force: true });
      options.report(`Removed expired failed-start sandbox directory ${sessionHash}.\n`);
    } catch (error) {
      options.report(`Could not prune sandbox session ${sessionHash}: ${String(error)}\n`);
    }
  }
}

export async function pruneInactiveSessions(options: {
  agentDir: string;
  nowUnixMs?: number;
  report: (text: string) => void;
}): Promise<void> {
  const sessionsDirectory = join(sandboxStorageRoot(options.agentDir), "sessions");
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  let sessionHashes: string[] = [];
  try {
    await rejectStorageSymlinks(sessionsDirectory);
    sessionHashes = await sessionDirectoryNames(sessionsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      options.report(`Could not scan inactive sandbox sessions: ${String(error)}\n`);
      return;
    }
  }
  const liveHashes = await liveSessionHashes(sessionsDirectory, sessionHashes);
  const sweeps = [
    () => removeAbandonedContainers({ sessionsDirectory, liveHashes, nowUnixMs, ...options }),
    () => removeAbandonedSessionImages({ liveHashes, report: options.report }),
    () =>
      removeExpiredFailedStartDirectories({
        sessionsDirectory,
        sessionHashes,
        liveHashes,
        nowUnixMs,
        report: options.report,
      }),
  ];
  for (const sweep of sweeps) {
    try {
      await sweep();
    } catch (error) {
      options.report(`Sandbox cleanup step failed: ${String(error)}\n`);
    }
  }
}
