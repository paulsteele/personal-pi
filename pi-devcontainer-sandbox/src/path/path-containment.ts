import { posix } from "node:path";
import { isSafeSystemPath } from "../safe-system-paths.ts";

export function isPathOutsideWorkingDirectory(
  canonicalPath: string,
  canonicalCwd: string,
): boolean {
  if (!canonicalPath || !canonicalCwd || isSafeSystemPath(canonicalPath)) return false;
  if (canonicalPath === canonicalCwd) return false;
  const relative = posix.relative(canonicalCwd, canonicalPath);
  return relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative);
}
