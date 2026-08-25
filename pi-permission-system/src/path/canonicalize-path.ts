import { realpathSync } from "node:fs";
import { posix } from "node:path";

/** Resolve existing ancestors through symlinks while preserving a missing tail. */
export function canonicalizePath(absolutePath: string): string {
  if (!absolutePath) return absolutePath;
  const parts = absolutePath.split("/").filter(Boolean);
  for (let index = parts.length; index >= 0; index -= 1) {
    const candidate = `/${parts.slice(0, index).join("/")}` || "/";
    try {
      const resolved = realpathSync(candidate);
      const tail = parts.slice(index);
      return tail.length > 0 ? posix.join(resolved, ...tail) : resolved;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return absolutePath;
    }
  }
  return absolutePath;
}
