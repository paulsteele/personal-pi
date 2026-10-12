import { projectStoragePath, type ProjectLocation } from "@paulsteele/pi-project-locations";
import { z } from "zod";
import type { DevcontainerDefinition } from "./definition.ts";
import { imageToolInstallationSchema } from "./image-tool-recipe.ts";
import { sandboxStorageRoot } from "./settings.ts";
import { readPrivateText } from "./storage.ts";
import { parseUniqueJson } from "./tool-profile.ts";

const argument = z
  .string()
  .max(16_000)
  .refine((value) => !value.includes("\0"));
const command = z.union([argument, z.array(argument).min(1).max(128)]);
const lifecycleCommand = z.union([command, z.record(z.string().min(1).max(100), command)]);
const environment = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), argument);
export const CONTAINER_LIFECYCLE_PHASES = [
  "onCreateCommand",
  "updateContentCommand",
  "postCreateCommand",
  "postStartCommand",
  "postAttachCommand",
] as const;

export const projectEnvironmentSchema = z.strictObject({
  version: z.literal(1),
  installations: z.array(imageToolInstallationSchema).max(64).default([]),
  files: z.record(z.string().min(1).max(4096), z.string().max(256_000)).default({}),
  containerEnv: environment.default({}),
  remoteEnv: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), argument.nullable())
    .default({}),
  onCreateCommand: lifecycleCommand.optional(),
  updateContentCommand: lifecycleCommand.optional(),
  postCreateCommand: lifecycleCommand.optional(),
  postStartCommand: lifecycleCommand.optional(),
  postAttachCommand: lifecycleCommand.optional(),
});
export type ProjectEnvironment = z.output<typeof projectEnvironmentSchema>;
export interface StoredProjectEnvironment {
  path: string;
  revision: string;
  environment: ProjectEnvironment;
}

export function projectEnvironmentPath(agentDir: string, project: ProjectLocation): string {
  return projectStoragePath(
    sandboxStorageRoot(agentDir),
    project,
    "devcontainer/project-environment.json",
  );
}

export function parseProjectEnvironment(value: unknown): ProjectEnvironment {
  const environment = projectEnvironmentSchema.parse(value);
  const installationIds = environment.installations.map((installation) => installation.id);
  if (new Set(installationIds).size !== installationIds.length) {
    throw new Error("Duplicate project installation ID");
  }
  if (Object.keys(environment.files).length > 32) {
    throw new Error("Project environment may contain at most 32 companion files");
  }
  for (const path of Object.keys(environment.files)) {
    const segments = path.split("/");
    if (
      path.includes("\\") ||
      path.includes("\0") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error(`Expected a relative project companion path: ${path}`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(environment)) > 1024 * 1024) {
    throw new Error("Project environment exceeds 1 MiB");
  }
  return environment;
}

export async function loadProjectEnvironment(
  path: string,
): Promise<StoredProjectEnvironment | undefined> {
  const stored = await readPrivateText(path);
  if (!stored) {
    return undefined;
  }
  return {
    path,
    revision: stored.revision,
    environment: parseProjectEnvironment(parseUniqueJson(stored.text)),
  };
}

export const orderedLifecycleRunner = `import concurrent.futures
import json
import subprocess
import sys


def execute_command(command):
    if isinstance(command, str):
        return subprocess.run(command, shell=True, executable="/bin/sh").returncode
    return subprocess.run(command).returncode


def execute_phase(phase):
    if not isinstance(phase, dict):
        return execute_command(phase)
    if not phase:
        return 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(phase)) as pool:
        statuses = list(pool.map(execute_command, phase.values()))
    return next((status for status in statuses if status != 0), 0)


for phase in json.loads(sys.argv[1]):
    status = execute_phase(phase)
    if status != 0:
        sys.exit(status if status > 0 else 128 - status)
`;

export function applyProjectEnvironment(
  base: DevcontainerDefinition,
  supplement: ProjectEnvironment,
): DevcontainerDefinition {
  const effective = structuredClone(base);
  if (Object.keys(supplement.containerEnv).length) {
    effective.containerEnv = { ...base.containerEnv, ...supplement.containerEnv };
  }
  if (Object.keys(supplement.remoteEnv).length) {
    effective.remoteEnv = { ...base.remoteEnv, ...supplement.remoteEnv };
  }
  for (const phase of CONTAINER_LIFECYCLE_PHASES) {
    const addition = supplement[phase];
    if (addition === undefined) {
      continue;
    }
    const original = base[phase];
    effective[phase] =
      original === undefined
        ? structuredClone(addition)
        : ["python3", "-c", orderedLifecycleRunner, JSON.stringify([original, addition])];
  }
  return effective;
}
