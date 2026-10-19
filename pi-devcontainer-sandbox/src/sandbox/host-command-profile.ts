import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { projectStoragePath, type ProjectLocation } from "@paulsteele/pi-project-locations";
import { z } from "zod";
import { sandboxStorageRoot } from "./settings.ts";
import { isPathInside, readPrivateText } from "./storage.ts";

const commandPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\0\\]/.test(value));
const scriptPath = commandPath.refine(
  (value) => !isAbsolute(value) && !value.split("/").includes(".."),
  "Scripts must be project-relative paths without parent traversal",
);
const executableName = z.string().regex(/^[A-Za-z0-9_+.-]+$/);
export const hostCommandProfileSchema = z.strictObject({
  hostCommands: z
    .array(
      z.union([
        z.strictObject({ script: scriptPath }),
        z.strictObject({ executable: executableName, path: commandPath.optional() }),
      ]),
    )
    .max(64),
});
export type HostCommandRule = z.output<typeof hostCommandProfileSchema>["hostCommands"][number];
export interface HostCommandProfile {
  path: string;
  revision: string | undefined;
  rules: HostCommandRule[];
}

export function hostCommandProfilePath(agentDir: string, project: ProjectLocation): string {
  return projectStoragePath(sandboxStorageRoot(agentDir), project, "host-commands.json");
}

export async function loadHostCommandProfile(
  agentDir: string,
  project: ProjectLocation,
): Promise<HostCommandProfile> {
  const path = hostCommandProfilePath(agentDir, project);
  const stored = await readPrivateText(path);
  const rules = stored ? hostCommandProfileSchema.parse(JSON.parse(stored.text)).hostCommands : [];
  for (const rule of rules) {
    if ("path" in rule && rule.path && !isAbsolute(rule.path)) {
      throw new Error("Host executable paths must be absolute");
    }
  }
  return { path, revision: stored?.revision, rules };
}

export function matchesHostCommand(rule: HostCommandRule, command: string): boolean {
  if ("executable" in rule) {
    return command === rule.executable || (rule.path !== undefined && command === rule.path);
  }
  return command.includes("/") && basename(command) === basename(rule.script);
}

export async function resolveHostExecutable(
  rule: HostCommandRule,
  projectRoot: string,
  hostCwd: string,
  command: string,
): Promise<string> {
  if ("script" in rule) {
    const configured = resolve(projectRoot, rule.script);
    const executable = await realpath(resolve(hostCwd, command));
    if (!isPathInside(projectRoot, executable) || executable !== (await realpath(configured))) {
      throw new Error(`Host script does not match the configured project path: ${command}`);
    }
    await access(executable, constants.X_OK);
    if (!(await stat(executable)).isFile()) {
      throw new Error("Host script is not a regular file");
    }
    return executable;
  }
  const candidates = rule.path
    ? [rule.path]
    : (process.env.PATH ?? "")
        .split(":")
        .filter(isAbsolute)
        .map((directory) => join(directory, rule.executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) {
        return await realpath(candidate);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EACCES") {
        throw error;
      }
    }
  }
  throw new Error(`Configured host executable is unavailable: ${rule.executable}`);
}
