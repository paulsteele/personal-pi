export const SANDBOX_MODE_ENTRY = "sandbox:mode";
export const NO_SANDBOX_FLAG = "no-sandbox";
export const HOST_MODE_UNAVAILABLE_REASON = "Sandbox is off for this session; run /sandbox on";

export type SandboxMode = "sandboxed" | "host";

export interface SandboxModeEntry {
  off: boolean;
}

function latestSessionModeChoice(branch: readonly unknown[]): SandboxMode | undefined {
  for (const entry of [...branch].reverse()) {
    const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (item?.type !== "custom" || item.customType !== SANDBOX_MODE_ENTRY) {
      continue;
    }
    const data = item.data as Partial<SandboxModeEntry> | undefined;
    if (typeof data?.off === "boolean") {
      return data.off ? "host" : "sandboxed";
    }
  }
  return undefined;
}

/**
 * A launch-time opt-out (flag or PI_SANDBOX=off) wins so a broken engine can
 * always be bypassed; otherwise the latest /sandbox off|on choice recorded in
 * this session applies. New sessions default to sandboxed.
 */
export function resolveSandboxMode(options: {
  branch: readonly unknown[];
  noSandboxFlag: boolean;
  environment: NodeJS.ProcessEnv;
}): SandboxMode {
  const launchedWithoutSandbox =
    options.noSandboxFlag || options.environment.PI_SANDBOX?.toLowerCase() === "off";
  if (launchedWithoutSandbox) {
    return "host";
  }
  return latestSessionModeChoice(options.branch) ?? "sandboxed";
}
