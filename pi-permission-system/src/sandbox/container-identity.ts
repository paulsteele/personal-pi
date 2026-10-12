import { basename } from "node:path";
import { sha256Hex } from "./storage.ts";

export function containerIdentity(options: {
  projectRoot: string;
  startupDirectory: string;
  sessionId: string;
  generation: number;
}): { name: string; labels: Record<string, string> } {
  const projectName =
    basename(options.projectRoot)
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^[_.-]+|[_.-]+$/g, "")
      .slice(0, 48) || "project";
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
