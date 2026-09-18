import { realpathSync, statSync } from "node:fs";
import { posix } from "node:path";

/** Trusted, in-process extension API; never inferred from tool output or model text. */
export const ALLOW_SESSION_FILES_CHANNEL = "permissions:allow_session_files";

export interface AllowSessionFilesEvent {
  version: 1;
  sessionId: string;
  paths: string[];
}

/** Exact existing files only: no globs, directories, missing targets, or session replay. */
export function sessionFileGrants(data: unknown, sessionId: string): string[] {
  if (!data || typeof data !== "object" || !sessionId) return [];
  const event = data as Partial<AllowSessionFilesEvent>;
  if (
    event.version !== 1 ||
    event.sessionId !== sessionId ||
    !Array.isArray(event.paths) ||
    event.paths.length === 0 ||
    event.paths.length > 100
  )
    return [];
  const paths: string[] = [];
  for (const path of event.paths) {
    if (typeof path !== "string" || !posix.isAbsolute(path)) return [];
    try {
      const canonical = realpathSync(path);
      if (!statSync(canonical).isFile()) return [];
      paths.push(canonical);
    } catch {
      return [];
    }
  }
  return [...new Set(paths)];
}
