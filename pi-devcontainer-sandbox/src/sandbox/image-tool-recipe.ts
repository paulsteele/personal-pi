import { z } from "zod";

export const installationArgumentSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));

export const imageToolInstallationSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  version: installationArgumentSchema,
  command: z.array(installationArgumentSchema).min(1).max(128),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), installationArgumentSchema),
  executable: installationArgumentSchema,
  prerequisites: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).max(16),
});

export type ImageToolInstallation = z.output<typeof imageToolInstallationSchema>;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function installationInstruction(tool: ImageToolInstallation): string {
  const prerequisiteChecks = tool.prerequisites.map((prerequisite) => {
    const missingPrerequisiteMessage = `Missing image prerequisite: ${prerequisite} for ${tool.id}`;
    return [
      `command -v ${shellQuote(prerequisite)} >/dev/null`,
      `|| { echo ${shellQuote(missingPrerequisiteMessage)} >&2; exit 1; }`,
    ].join(" ");
  });
  const environmentAssignments = Object.entries(tool.environment).map(
    ([key, value]) => `${key}=${shellQuote(value)}`,
  );
  const installCommand = ["env", ...environmentAssignments, ...tool.command.map(shellQuote)].join(
    " ",
  );
  const shellCommands = ["set -eu", ...prerequisiteChecks, installCommand];
  return `RUN ${JSON.stringify(["sh", "-c", shellCommands.join("; ")])}`;
}
