import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { sandboxStorageRoot } from "./settings.ts";
import { isPathInside } from "./storage.ts";

export const HOST_READ_TOOLS: ReadonlySet<string> = new Set(["read", "ls", "grep", "find"]);

export interface HostReadRoots {
  directories: string[];
  extensionsDirectory: string;
  sandboxStorage: string;
  excluded: string[];
}

export function hostReadRoots(agentDir: string): HostReadRoots {
  const sandboxStorage = sandboxStorageRoot(agentDir);
  return {
    directories: [getPackageDir(), join(agentDir, "sessions")],
    extensionsDirectory: join(agentDir, "extensions"),
    sandboxStorage,
    excluded: [sandboxStorage, join(agentDir, "auth.json")],
  };
}

function isExtensionConfigFile(path: string, extensionsDirectory: string): boolean {
  return basename(path) === "config.json" && dirname(dirname(path)) === extensionsDirectory;
}

const startupLogPathWithinSandboxStorage = /^sessions\/[^/]+\/startup-logs(?:\/[^/]+\.jsonl)?$/;

function isStartupLogPath(path: string, sandboxStorage: string): boolean {
  return startupLogPathWithinSandboxStorage.test(relative(sandboxStorage, path));
}

async function canonicalOrLexical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

function expandHome(path: string): string {
  return path.replace(/^~(?=\/|$)/, homedir());
}

/**
 * Returns the canonical host path when `requestedPath` names readable Pi resources outside the
 * container: Pi's own package (docs/examples), session transcripts, other extensions' config
 * files, and sandbox startup logs. Other pi-permission-system storage and credentials are never
 * included.
 */
export async function hostReadablePath(
  requestedPath: unknown,
  agentDir: string,
): Promise<string | undefined> {
  if (typeof requestedPath !== "string") {
    return undefined;
  }
  const expanded = expandHome(requestedPath);
  if (!isAbsolute(expanded)) {
    return undefined;
  }
  const roots = hostReadRoots(agentDir);
  const canonicalPath = await canonicalOrLexical(expanded);
  const canonicalRoots = await Promise.all(roots.directories.map(canonicalOrLexical));
  const canonicalExcluded = await Promise.all(roots.excluded.map(canonicalOrLexical));
  const canonicalExtensions = await canonicalOrLexical(roots.extensionsDirectory);
  const canonicalSandboxStorage = await canonicalOrLexical(roots.sandboxStorage);
  if (isStartupLogPath(canonicalPath, canonicalSandboxStorage)) {
    return canonicalPath;
  }
  if (canonicalExcluded.some((excluded) => isPathInside(excluded, canonicalPath))) {
    return undefined;
  }
  const isInsideReadableRoot = canonicalRoots.some((root) => isPathInside(root, canonicalPath));
  if (isInsideReadableRoot || isExtensionConfigFile(canonicalPath, canonicalExtensions)) {
    return canonicalPath;
  }
  return undefined;
}
