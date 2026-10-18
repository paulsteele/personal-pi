import { basename } from "node:path";
import type { SandboxSession } from "./session.ts";
import type { ResolvedTool } from "./tool-profile.ts";

const prerequisiteProbeTimeoutMs = 10_000;

export class MissingPrerequisitesError extends Error {
  constructor(
    readonly toolId: string,
    readonly missing: readonly string[],
  ) {
    super(
      `${toolId} needs ${missing.join(", ")}, which the sandbox image does not provide. Request ${missing.join(" and ")} with request_sandbox_tool first, then retry ${toolId}. Nothing was saved.`,
    );
  }
}

export function prerequisiteProviderIds(
  prerequisites: readonly string[],
  profileTools: readonly ResolvedTool[],
): string[] {
  const providerIds = new Set<string>();
  for (const prerequisite of prerequisites) {
    const provider = profileTools.find((tool) => {
      const providesByName = tool.id === prerequisite;
      const providesByExecutable =
        tool.entry.kind === "recipe" && basename(tool.entry.executable) === prerequisite;
      return providesByName || providesByExecutable;
    });
    if (provider) {
      providerIds.add(provider.id);
    }
  }
  return [...providerIds].sort();
}

export async function findMissingPrerequisites(
  session: SandboxSession,
  prerequisites: readonly string[],
  signal: AbortSignal,
): Promise<string[]> {
  if (!prerequisites.length) {
    return [];
  }
  const reportMissing = 'for name; do command -v "$name" >/dev/null 2>&1 || echo "$name"; done';
  const probe = await session.execute({
    command: ["sh", "-c", reportMissing, "sh", ...prerequisites],
    signal,
    timeoutMs: prerequisiteProbeTimeoutMs,
  });
  return probe.output.toString().split(/\s+/).filter(Boolean);
}
