import { lstat, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { podmanOutput } from "./driver.ts";
import { sessionRecordSchema } from "./session-record.ts";
import { sandboxStorageRoot } from "./settings.ts";
import {
  publishPrivateText,
  readPrivateText,
  rejectStorageSymlinks,
  sha256Hex,
} from "./storage.ts";

export const inactiveSessionRetentionMs = 7 * 24 * 60 * 60 * 1000;

const containerInspectionSchema = z.object({
  Id: z.string(),
  Config: z.object({ Labels: z.record(z.string(), z.string()) }),
  State: z.object({ Running: z.boolean(), Status: z.string() }),
});

async function stoppedSessionContainers(sessionId: string): Promise<string[] | undefined> {
  const output = await podmanOutput([
    "ps",
    "--all",
    "--no-trunc",
    "--filter",
    `label=pi.sandbox.session=${sessionId}`,
    "--format",
    "{{.ID}}",
  ]);
  const containers: string[] = [];
  for (const id of output.split(/\s+/).filter(Boolean)) {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error("Invalid sandbox container ID during pruning");
    }
    const details = containerInspectionSchema.parse(
      JSON.parse(await podmanOutput(["inspect", "--type", "container", id]))[0],
    );
    if (details.Id !== id || details.Config.Labels["pi.sandbox.session"] !== sessionId) {
      throw new Error("Sandbox pruning encountered a container owned by another session");
    }
    const isStopped =
      !details.State.Running &&
      ["exited", "stopped", "created", "configured"].includes(details.State.Status);
    if (!isStopped) {
      return undefined;
    }
    containers.push(id);
  }
  return containers;
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

async function pruneInactiveSession(
  directory: string,
  sessionHash: string,
  nowUnixMs: number,
): Promise<number> {
  await rejectStorageSymlinks(directory);
  const lockPath = join(directory, "owner.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") {
      return undefined;
    }
    throw error;
  });
  if (!lock) {
    return 0;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    const recordPath = join(directory, "session.json");
    const stored = await readPrivateText(recordPath);
    if (!stored) {
      return 0;
    }
    const record = sessionRecordSchema.parse(JSON.parse(stored.text));
    if (sha256Hex(record.sessionId) !== sessionHash) {
      throw new Error("Sandbox pruning encountered a mismatched session record");
    }
    const inactiveSinceUnixMs = record.inactiveSinceUnixMs ?? (await lstat(recordPath)).mtimeMs;
    if (nowUnixMs - inactiveSinceUnixMs < inactiveSessionRetentionMs) {
      return 0;
    }
    const containers = await stoppedSessionContainers(record.sessionId);
    if (!containers) {
      return 0;
    }
    if (record.containerPrunedAtUnixMs === undefined) {
      await publishPrivateText(
        recordPath,
        JSON.stringify({
          ...record,
          inactiveSinceUnixMs: Math.floor(inactiveSinceUnixMs),
          containerPrunedAtUnixMs: nowUnixMs,
        }),
        stored.revision,
      );
    }
    for (const container of containers) {
      await podmanOutput(["rm", container]);
    }
    return containers.length;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function pruneInactiveSessions(options: {
  agentDir: string;
  nowUnixMs?: number;
  report: (text: string) => void;
}): Promise<void> {
  const sessionsDirectory = join(sandboxStorageRoot(options.agentDir), "sessions");
  try {
    await rejectStorageSymlinks(sessionsDirectory);
    const entries = await readdir(sessionsDirectory, { withFileTypes: true });
    const nowUnixMs = options.nowUnixMs ?? Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) {
        continue;
      }
      try {
        const removed = await pruneInactiveSession(
          join(sessionsDirectory, entry.name),
          entry.name,
          nowUnixMs,
        );
        if (removed > 0) {
          options.report(`Pruned ${removed} inactive sandbox container(s) for ${entry.name}.\n`);
        }
      } catch (error) {
        options.report(`Could not prune sandbox session ${entry.name}: ${String(error)}\n`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      options.report(`Could not scan inactive sandbox sessions: ${String(error)}\n`);
    }
  }
}
