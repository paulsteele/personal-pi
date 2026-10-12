import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { planImageTools } from "./image-tools.ts";
import type { SandboxSession } from "./session.ts";
import { silentStartupProgress, type SandboxStartupProgress } from "./startup-ui.ts";
import { projectToolProfilePath } from "./tool-profile.ts";

const installArgument = Type.String({ minLength: 1, maxLength: 4096 });
const requestParameters = Type.Object({
  tool: Type.String({ pattern: "^[a-zA-Z0-9_-]+$", maxLength: 100 }),
  version: installArgument,
  command: Type.Array(installArgument, { minItems: 1, maxItems: 128 }),
  executable: installArgument,
  prerequisites: Type.Array(Type.String({ pattern: "^[a-zA-Z0-9_-]+$" }), { maxItems: 16 }),
  environment: Type.Optional(
    Type.Record(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), installArgument),
  ),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
});
type SandboxToolRequest = Static<typeof requestParameters>;

export async function requestSandboxTool(
  session: SandboxSession,
  request: SandboxToolRequest,
  signal: AbortSignal,
  toolCallId: string,
  report: (text: string) => void = () => {},
) {
  signal.throwIfAborted();
  report(`Preparing ${request.tool} (${request.version}) image installation…`);
  const proposal = await planImageTools(
    session,
    [
      {
        id: request.tool,
        version: request.version,
        command: request.command,
        executable: request.executable,
        prerequisites: request.prerequisites,
        environment: request.environment ?? {},
      },
    ],
    signal,
  );
  if (proposal) {
    const preview = [
      `Install ${request.tool} (${request.version}) into the devcontainer image?`,
      `Reason: ${request.reason}`,
      `Expected executable: ${request.executable}`,
      "Installation commands run as root during the image build, not on the host. Container processes and language servers will restart.",
      proposal.preview,
    ].join("\n\n");
    if (!(await session.options.confirm(preview, signal, toolCallId))) {
      throw new Error("Sandbox tool installation was not approved");
    }
    signal.throwIfAborted();
  }
  const installAndVerify = async (progress: SandboxStartupProgress) => {
    if (proposal) {
      report(`Rebuilding devcontainer image for ${request.tool}…`);
      await proposal.apply(signal);
      report("Devcontainer rebuild complete.");
    }
    const probeTimeoutMs = 10_000;
    const probeStage = `Checking runtime executable ${request.executable} (10-second timeout)…`;
    progress.stage(probeStage);
    report(probeStage);
    let probe: Awaited<ReturnType<SandboxSession["execute"]>>;
    try {
      probe = await session.execute({
        command: ["sh", "-c", 'command -v "$1"', "sh", request.executable],
        signal,
        timeoutMs: probeTimeoutMs,
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(
        `Tool recipe is saved, but the runtime executable probe for ${request.executable} failed: ${String(error)}. The rebuilt container is retained; verify Podman responsiveness before retrying.`,
        { cause: error },
      );
    }
    const executablePath = probe.output.toString().trim();
    if (probe.code !== 0 || !executablePath) {
      throw new Error(
        `Tool recipe is saved, but ${request.executable} is not available to the devcontainer runtime user. Request a corrected installation or PATH configuration before retrying.`,
      );
    }
    report(`Runtime executable verified: ${executablePath}`);
    return executablePath;
  };
  const executablePath = session.options.startup
    ? await session.options.startup.run(`Installing ${request.tool}`, installAndVerify)
    : await installAndVerify(silentStartupProgress);
  return {
    status: proposal ? "installed" : "already_in_definition",
    tool: request.tool,
    requestedVersion: request.version,
    executable: executablePath,
    definitionPath: session.options.resolved.path,
    definitionTier: session.options.resolved.tier,
    ...(session.options.resolved.layers
      ? {
          toolProfilePath: projectToolProfilePath(
            session.options.agentDir,
            session.options.resolved.project,
          ),
          toolScope: "project",
        }
      : {}),
    containerGeneration: session.generation,
  };
}

export function registerSandboxToolRequests(
  pi: ExtensionAPI,
  getSession: () => SandboxSession,
): void {
  pi.registerTool({
    name: "request_sandbox_tool",
    label: "Request sandbox tool installation",
    exposure: "model-only",
    executionMode: "sequential",
    description:
      "Recommend installing a missing development tool into the active devcontainer image. Supply a pinned version, exact Linux-compatible installation command as argv, expected executable, build prerequisites, and reason. Prefer a location on the runtime PATH (such as /usr/local/bin) or an absolute executable path. Optional environment values apply only to installation. Human approval is required before writing/building. Layered environments save private project tools without changing the base; legacy global-definition installs affect future projects. Rebuild discards container-local changes but preserves approved host binds. Cannot install on the host, grant mounts, or disable sandboxing.",
    parameters: requestParameters,
    async execute(id, input, signal, onUpdate) {
      const operationSignal = signal ?? new AbortController().signal;
      const result = await requestSandboxTool(getSession(), input, operationSignal, id, (text) => {
        onUpdate?.({ content: [{ type: "text", text }], details: undefined });
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
