import { dirname, join, resolve } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { sha256Hex } from "./storage.ts";
import { z } from "zod";
import { configPath, configSchema as legacyConfigSchema } from "../config.ts";
import { publishPrivateText, readPrivateText } from "./storage.ts";

const permissionState = z.enum(["allow", "ask", "deny"]);
const denyRule = z.strictObject({
  action: z.literal("deny"),
  reason: z.string().max(500).optional(),
});
const permissionRule = z.union([permissionState, denyRule]);
const permissionPolicy = z.record(
  z.string().min(1),
  z.union([permissionState, z.record(z.string().min(1), permissionRule)]),
);

export const sandboxSettingsSchema = z.strictObject({
  permission: permissionPolicy.default({}),
  sandbox: z
    .strictObject({
      modelAssistedSetup: z.boolean().default(false),
      hostEnvironment: z
        .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
        .max(64)
        .default([]),
      startupTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
      buildTimeoutMs: z.number().int().min(1000).max(7_200_000).default(1_800_000),
    })
    .default({
      modelAssistedSetup: false,
      hostEnvironment: [],
      startupTimeoutMs: 120_000,
      buildTimeoutMs: 1_800_000,
    }),
});

export type SandboxSettings = z.output<typeof sandboxSettingsSchema>;

export function sandboxStorageRoot(agentDir: string): string {
  return join(agentDir, "extensions", "pi-permission-system");
}

export function parseSandboxSettings(value: unknown): SandboxSettings {
  return sandboxSettingsSchema.parse(value);
}

export async function loadSandboxSettings(agentDir: string): Promise<{
  settings: SandboxSettings;
  revision?: string;
  needsMigration: boolean;
}> {
  const stored = await readPrivateText(configPath(agentDir));
  if (!stored) {
    return { settings: parseSandboxSettings({}), needsMigration: false };
  }
  const value: unknown = JSON.parse(stored.text);
  const current = sandboxSettingsSchema.safeParse(value);
  if (current.success) {
    return { settings: current.data, revision: stored.revision, needsMigration: false };
  }
  const legacy = legacyConfigSchema.safeParse(value);
  if (!legacy.success) {
    throw new Error(
      `Invalid sandbox settings at ${configPath(agentDir)}: ${current.error.message}`,
    );
  }
  return {
    settings: parseSandboxSettings({ permission: legacy.data.permission }),
    revision: stored.revision,
    needsMigration: true,
  };
}

export function sandboxDisclosureRevision(agentDir: string, authorityRevision: string): string {
  const path = configPath(agentDir);
  for (let ancestorPath = resolve(path); ; ancestorPath = dirname(ancestorPath)) {
    try {
      if (lstatSync(ancestorPath).isSymbolicLink()) {
        throw new Error(`Sandbox settings path must not be a symlink: ${ancestorPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (ancestorPath === dirname(ancestorPath)) {
      break;
    }
  }
  let text: string;
  try {
    if (lstatSync(path).size > 1024 * 1024) {
      throw new Error("Sandbox settings exceed 1 MiB");
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return sha256Hex(JSON.stringify([authorityRevision, parseSandboxSettings({})]));
  }
  const settings = parseSandboxSettings(JSON.parse(text));
  return sha256Hex(JSON.stringify([authorityRevision, settings]));
}

export async function saveSandboxSettings(
  agentDir: string,
  settings: SandboxSettings,
  expectedRevision: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const validated = parseSandboxSettings(settings);
  return publishPrivateText(
    configPath(agentDir),
    `${JSON.stringify(validated, null, 2)}\n`,
    expectedRevision,
    signal,
  );
}
