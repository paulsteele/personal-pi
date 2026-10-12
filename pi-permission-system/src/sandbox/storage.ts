import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isPathInside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith("../"));
}

export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const parent = dirname(path);
    if (parent === path) {
      throw error;
    }
    return resolve(await canonicalPath(parent), basename(path));
  }
}

export async function rejectStorageSymlinks(path: string): Promise<void> {
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Refusing symlink in private sandbox storage: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (dirname(current) === current) {
      return;
    }
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await rejectStorageSymlinks(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function readPrivateText(
  path: string,
): Promise<{ text: string; revision: string } | undefined> {
  await rejectStorageSymlinks(path);
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      throw new Error(`Invalid or oversized private sandbox file: ${path}`);
    }
    const text = await handle.readFile("utf8");
    return { text, revision: sha256Hex(text) };
  } finally {
    await handle.close();
  }
}

export async function withPrivateLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(dirname(path));
  await rejectStorageSymlinks(path);
  const lock = await open(path, "wx", 0o600).catch(() => {
    throw new Error(`Sandbox operation owns ${path}; inspect stale locks before retrying`);
  });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    return await operation();
  } finally {
    await lock.close();
    await unlink(path);
  }
}

export async function publishPrivateText(
  path: string,
  text: string,
  expectedRevision: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (Buffer.byteLength(text) > 1024 * 1024) {
    throw new Error("Private sandbox file exceeds 1 MiB");
  }
  return withPrivateLock(`${path}.lock`, async () => {
    signal?.throwIfAborted();
    if ((await readPrivateText(path))?.revision !== expectedRevision) {
      throw new Error(`Sandbox configuration changed since preview: ${path}`);
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
      await handle.close();
      signal?.throwIfAborted();
      await rename(temporary, path);
    } finally {
      await handle.close();
      await unlink(temporary).catch(() => {});
    }
    return sha256Hex(text);
  });
}
