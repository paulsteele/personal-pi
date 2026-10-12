import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SettingsDraft } from "./index.ts";

function contentHash(text: string | undefined): string | undefined {
  return text === undefined ? undefined : createHash("sha256").update(text).digest("hex");
}

async function readConfig(path: string): Promise<string | undefined> {
  for (let ancestor = path; ; ancestor = dirname(ancestor)) {
    try {
      if ((await lstat(ancestor)).isSymbolicLink()) {
        throw new Error("Settings paths must not contain symlinks");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (ancestor === dirname(ancestor)) {
      break;
    }
  }
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function fileSettingsDraft(
  path: string,
  validate: (value: Record<string, unknown>) => void = () => {},
  defaults: Record<string, unknown> = {},
): Promise<SettingsDraft> {
  const text = await readConfig(path);
  const parsed: unknown = text === undefined ? defaults : JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a settings object at ${path}`);
  }
  const value = parsed as Record<string, unknown>;
  validate(value);
  const expectedContentHash = contentHash(text);
  return {
    value,
    needsInitialPublication: text === undefined,
    async apply(next, signal) {
      signal?.throwIfAborted();
      validate(next);
      await readConfig(path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const lockPath = `${path}.lock`;
      const lock = await open(lockPath, "wx", 0o600).catch(() => {
        throw new Error(
          "Settings publication is already active; reopen the section before applying",
        );
      });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        if (contentHash(await readConfig(path)) !== expectedContentHash) {
          throw new Error("Settings changed outside this menu; reopen the section before applying");
        }
        signal?.throwIfAborted();
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        if (contentHash(await readConfig(path)) !== expectedContentHash) {
          throw new Error("Settings changed outside this menu; reopen the section before applying");
        }
        signal?.throwIfAborted();
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => {});
        await lock.close();
        await unlink(lockPath);
      }
    },
  };
}
