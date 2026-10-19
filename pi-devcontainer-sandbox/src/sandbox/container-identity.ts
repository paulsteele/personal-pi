import { basename } from "node:path";
import { sha256Hex } from "./storage.ts";

export function projectEngineSlug(projectRoot: string): string {
  return (
    basename(projectRoot)
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^[_.-]+|[_.-]+$/g, "")
      .slice(0, 48) || "project"
  );
}

export const SESSION_IMAGE_REPOSITORY_PREFIX = "localhost/pi-sandbox-";
const sessionImageHashLength = 20;

export function sessionImageHashPrefix(sessionId: string): string {
  return sha256Hex(sessionId).slice(0, sessionImageHashLength);
}

export function sessionImageName(sessionId: string): string {
  return `${SESSION_IMAGE_REPOSITORY_PREFIX}${sessionImageHashPrefix(sessionId)}`;
}

const checkpointRepositorySuffix = "-checkpoint";

export function sessionCheckpointImageName(sessionId: string, generation: number): string {
  return `${sessionImageName(sessionId)}${checkpointRepositorySuffix}:g${generation}`;
}

export function isSessionCheckpointImage(imageReference: string): boolean {
  const tagSeparator = imageReference.lastIndexOf(":");
  const repository = tagSeparator < 0 ? imageReference : imageReference.slice(0, tagSeparator);
  return repository.endsWith(checkpointRepositorySuffix);
}

export function sessionHashPrefixOfImage(imageReference: string): string | undefined {
  if (!imageReference.startsWith(SESSION_IMAGE_REPOSITORY_PREFIX)) {
    return undefined;
  }
  const hashPrefix = imageReference.slice(
    SESSION_IMAGE_REPOSITORY_PREFIX.length,
    SESSION_IMAGE_REPOSITORY_PREFIX.length + sessionImageHashLength,
  );
  return /^[a-f0-9]{20}$/.test(hashPrefix) ? hashPrefix : undefined;
}

export function containerIdentity(options: {
  projectRoot: string;
  startupDirectory: string;
  sessionId: string;
  generation: number;
}): { name: string; labels: Record<string, string> } {
  const projectName = projectEngineSlug(options.projectRoot);
  const sessionSuffix = sha256Hex(options.sessionId).slice(0, 10);
  if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
    throw new Error("Container generation must be a positive integer");
  }
  return {
    name: `pi-${projectName}-${sessionSuffix}-g${options.generation}`,
    labels: {
      "pi.sandbox.project": basename(options.projectRoot),
      "pi.sandbox.project-root": options.projectRoot,
      "pi.sandbox.startup-directory": options.startupDirectory,
      "pi.sandbox.session": options.sessionId,
      "pi.sandbox.generation": String(options.generation),
    },
  };
}
