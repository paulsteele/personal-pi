import { posix } from "node:path";
import { READ_ONLY_PATH_BEARING_TOOLS } from "../access-intent/path-surfaces.ts";

/** Fixed personal-runtime roots only; config cannot widen this bypass. */
export function isPiInfrastructureRead(
  toolName: string,
  normalizedPath: string,
  roots: readonly string[],
  _cwd: string,
): boolean {
  if (!READ_ONLY_PATH_BEARING_TOOLS.has(toolName)) return false;
  return roots.some((root) => {
    const normalizedRoot = posix.normalize(root).replace(/\/$/, "");
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
  });
}
