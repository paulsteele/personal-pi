import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isPathInside, sha256Hex, readPrivateText } from "./storage.ts";

export async function fingerprintBuildContext(
  context: string,
  signal?: AbortSignal,
): Promise<string> {
  const root = await realpath(context);
  const entries: string[] = [];
  let scanned = 0;
  const maxEntries = 20_000;
  async function scanBuildContextDirectory(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (++scanned > maxEntries) {
        throw new Error("Build context exceeds 20,000 entries; use a narrower context");
      }
      const path = join(directory, entry.name);
      const stat = await lstat(path, { bigint: true });
      if (stat.isSymbolicLink()) {
        const target = await realpath(path);
        if (!isPathInside(root, target)) {
          throw new Error(`Build context symlink escapes its approved root: ${path}`);
        }
      } else if (!stat.isDirectory() && !stat.isFile()) {
        throw new Error(`Build context contains a socket or device: ${path}`);
      }
      entries.push(`${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
      if (stat.isDirectory() && entry.name !== ".git") {
        await scanBuildContextDirectory(path);
      }
    }
  }
  await scanBuildContextDirectory(root);
  const ignore = await readPrivateText(join(root, ".dockerignore"));
  const containerIgnore = await readPrivateText(join(root, ".containerignore"));
  return sha256Hex(JSON.stringify([entries.sort(), ignore?.revision, containerIgnore?.revision]));
}
