import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { z } from "zod";

const ownerLockSchema = z.object({
  pid: z.number().int().positive(),
  reloadHandoff: z.boolean().optional(),
});

type OwnerLockRecord = z.output<typeof ownerLockSchema>;

export interface OwnerLock {
  readonly path: string;
  readonly replacedStaleOwnerPid?: number;
  release(): Promise<void>;
  handOffForReload(): Promise<void>;
}

export class SessionOwnedError extends Error {
  constructor(readonly ownerPid: number | undefined) {
    super(
      ownerPid === undefined
        ? "This Pi session sandbox is owned by another process"
        : `This Pi session sandbox is owned by running process ${ownerPid}`,
    );
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwnerRecord(path: string): Promise<OwnerLockRecord | undefined> {
  try {
    return ownerLockSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

function canReplaceOwner(
  owner: OwnerLockRecord | undefined,
  canReplaceOwnReloadHandoff: boolean,
): owner is OwnerLockRecord {
  if (!owner) {
    return false;
  }
  const isOwnReloadHandoff = owner.pid === process.pid && owner.reloadHandoff === true;
  return (canReplaceOwnReloadHandoff && isOwnReloadHandoff) || !isProcessAlive(owner.pid);
}

export async function hasLiveOwner(path: string): Promise<boolean> {
  const owner = await readOwnerRecord(path);
  return owner !== undefined && isProcessAlive(owner.pid);
}

export async function acquireOwnerLock(
  path: string,
  options: { canReplaceOwnReloadHandoff?: boolean } = {},
): Promise<OwnerLock | undefined> {
  const ownerRecord = JSON.stringify({ pid: process.pid });
  const create = () => open(path, "wx", 0o600);
  let handle = await create().catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") {
      return undefined;
    }
    throw error;
  });
  let replacedStaleOwnerPid: number | undefined;
  if (!handle) {
    const owner = await readOwnerRecord(path);
    if (!canReplaceOwner(owner, options.canReplaceOwnReloadHandoff ?? false)) {
      return undefined;
    }
    await unlink(path).catch(() => {});
    handle = await create().catch(() => undefined);
    if (!handle) {
      return undefined;
    }
    replacedStaleOwnerPid = owner.pid === process.pid ? undefined : owner.pid;
  }
  await handle.writeFile(ownerRecord);
  await handle.close();
  return {
    path,
    replacedStaleOwnerPid,
    release: () => unlink(path).catch(() => {}),
    handOffForReload: () =>
      writeFile(path, JSON.stringify({ pid: process.pid, reloadHandoff: true }), { mode: 0o600 }),
  };
}

export async function requireOwnerLock(path: string): Promise<OwnerLock> {
  const lock = await acquireOwnerLock(path, { canReplaceOwnReloadHandoff: true });
  if (!lock) {
    throw new SessionOwnedError((await readOwnerRecord(path))?.pid);
  }
  return lock;
}
