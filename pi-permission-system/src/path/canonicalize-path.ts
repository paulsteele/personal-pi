import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { posix } from "node:path";

/** Resolve symlinks, including dangling destinations, before preserving a missing tail. */
export function canonicalizePath(absolutePath: string): string {
  if (!absolutePath) return absolutePath;
  try {
    return realpathSync(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return absolutePath;
  }
  let resolved = "/";
  let remaining = absolutePath.split("/").filter(Boolean);
  let links = 0;
  while (remaining.length > 0) {
    const part = remaining.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      resolved = posix.dirname(resolved);
      continue;
    }
    const candidate = posix.join(resolved, part);
    try {
      if (lstatSync(candidate).isSymbolicLink()) {
        if (++links > 40) return absolutePath;
        const target = readlinkSync(candidate);
        if (posix.isAbsolute(target)) resolved = "/";
        remaining = [...target.split("/").filter(Boolean), ...remaining];
      } else {
        resolved = realpathSync(candidate);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return posix.join(candidate, ...remaining);
      return absolutePath;
    }
  }
  return resolved;
}
