import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const state = z.enum(["allow", "deny", "ask"]);
const deny = z.strictObject({ action: z.literal("deny"), reason: z.string().max(500).optional() });
const ruleValue = z.union([state, deny]);
const permission = z.record(
  z.string().min(1),
  z.union([state, z.record(z.string().min(1), ruleValue)]),
);

const environment = z.strictObject({
  trustedRoots: z.array(z.string().min(1).max(200)).max(100).default([]),
  trustedRemotes: z.array(z.string().min(1).max(200)).max(100).default([]),
  trustedDomains: z.array(z.string().min(1).max(200)).max(100).default([]),
});

export const configSchema = z.strictObject({
  permission: permission.default({ "*": "ask" }),
  auto: z.strictObject({
    provider: z.string().min(1),
    model: z.string().min(1),
    enabledByDefault: z.boolean().default(true),
    timeoutMs: z.number().int().min(250).max(60_000).default(20_000),
    contextUserTurns: z.number().int().min(0).max(20).default(3),
    environment: environment.default({ trustedRoots: [], trustedRemotes: [], trustedDomains: [] }),
  }),
});

export type Config = z.output<typeof configSchema>;
export type PermissionState = z.infer<typeof state>;
export type RuleValue = z.infer<typeof ruleValue>;

export const DEFAULT_CONFIG: Config = {
  permission: { "*": "ask" },
  auto: {
    provider: "litellm",
    model: "amod-gpt-5.6-luna",
    enabledByDefault: true,
    timeoutMs: 20_000,
    contextUserTurns: 3,
    environment: { trustedRoots: [], trustedRemotes: [], trustedDomains: [] },
  },
};

export function configPath(agentDir: string): string {
  return join(agentDir, "extensions", "pi-permission-system", "config.json");
}

export function loadConfig(agentDir: string): { config: Config; issues: string[] } {
  const path = configPath(agentDir);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const result = configSchema.safeParse(raw);
    return result.success
      ? { config: result.data, issues: [] }
      : {
          config: DEFAULT_CONFIG,
          issues: result.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`),
        };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? {
          config: DEFAULT_CONFIG,
          issues: [`Missing global permission config at ${path}; using safe defaults.`],
        }
      : {
          config: DEFAULT_CONFIG,
          issues: [`Invalid global permission config at ${path}; using safe defaults.`],
        };
  }
}

function updateAuto(agentDir: string, patch: Partial<Config["auto"]>): void {
  const loaded = loadConfig(agentDir);
  if (loaded.issues.length > 0 && existsSync(configPath(agentDir))) {
    throw new Error(`Refusing to overwrite invalid permission config: ${loaded.issues.join("; ")}`);
  }
  const next: Config = { ...loaded.config, auto: { ...loaded.config.auto, ...patch } };
  const path = configPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

export function saveAutoEnabled(agentDir: string, enabledByDefault: boolean): void {
  updateAuto(agentDir, { enabledByDefault });
}

export function saveAutoModel(agentDir: string, provider: string, model: string): void {
  updateAuto(agentDir, { provider, model });
}
