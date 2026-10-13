import { BorderedLoader, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { inputPanel, presentPanel } from "@paulsteele/pi-shared-ui";
import { Check } from "typebox/value";
import { awaitSandboxWork } from "./cancellation.ts";
import { resolveSandboxProject } from "./definition.ts";
import { imageToolInstallationSchema } from "./image-tool-recipe.ts";
import type { SandboxSession } from "./session.ts";
import {
  requestSandboxTool,
  sandboxToolRequestParameters,
  type SandboxToolRequest,
} from "./tool-installation.ts";

const recipeInstructions = `Prepare one pinned Linux development-tool installation recipe for the operator's request.
Return it by calling submit_tool_recipe. Do not execute commands or claim that the recipe is verified.
The command is an argv array executed as root during an image build, never on the host.
For an install script use ["sh", "-c", "set -eu; ..."]. Pin the requested tool to an exact release, never latest or a floating range.
Use the supplied Linux distribution and CPU architecture. Install to the runtime PATH (such as /usr/local/bin) or provide an absolute executable path.
Prerequisites list commands that must already exist in the build image; include prerequisite installation in the script if needed.
Private language-server runtimes under /opt/pi-tools are runtime mounts and unavailable during this build. Do not depend on them or write there.
Environment values apply only to installation, not runtime. Do not request credentials, host files, mounts, or sandbox exceptions.
The tool field is a short stable identifier. Explain the recipe's purpose in reason.`;

export async function generateSandboxToolRecipe(
  ctx: ExtensionContext,
  session: SandboxSession,
  description: string,
  signal: AbortSignal,
): Promise<SandboxToolRequest> {
  const model = ctx.model;
  if (!model) {
    throw new Error("Select a model before generating a tool recipe");
  }
  const recipeThinkingLevel = clampThinkingLevel(model, ctx.thinkingLevel ?? "low");
  signal.throwIfAborted();
  const platform = await session.execute({
    command: ["sh", "-c", "cat /etc/os-release; uname -m"],
    timeoutMs: 10_000,
    signal,
  });
  if (platform.code !== 0) {
    throw new Error("Could not inspect the sandbox Linux distribution and architecture");
  }
  const response = await awaitSandboxWork(
    ctx.modelRegistry
      .streamSimple(
        model,
        {
          systemPrompt: recipeInstructions,
          messages: [
            {
              role: "user",
              content: `Requested tool: ${description}\n\nSandbox platform:\n${platform.output.toString()}`,
              timestamp: Date.now(),
            },
          ],
          tools: [
            {
              name: "submit_tool_recipe",
              description:
                "Submit a pinned installation recipe for operator review; executes nothing.",
              parameters: sandboxToolRequestParameters,
            },
          ],
        },
        {
          signal,
          maxTokens: 4096,
          reasoning: recipeThinkingLevel === "off" ? undefined : recipeThinkingLevel,
        },
      )
      .result(),
    signal,
  );
  signal.throwIfAborted();
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? "Tool recipe generation failed");
  }
  const recipes = response.content.filter(
    (part) => part.type === "toolCall" && part.name === "submit_tool_recipe",
  );
  const recipe = recipes.length === 1 ? recipes[0] : undefined;
  if (
    !recipe ||
    recipe.type !== "toolCall" ||
    !Check(sandboxToolRequestParameters, recipe.arguments)
  ) {
    throw new Error("The model did not return one valid pinned tool recipe; nothing was saved");
  }
  const request = recipe.arguments;
  imageToolInstallationSchema.parse({
    id: request.tool,
    version: request.version,
    command: request.command,
    executable: request.executable,
    prerequisites: request.prerequisites,
    environment: request.environment ?? {},
  });
  return request;
}

type RecipeGenerationResult =
  | { status: "generated"; request: SandboxToolRequest }
  | { status: "failed"; error: unknown }
  | { status: "cancelled" };

async function generateWithProgress(
  ctx: ExtensionContext,
  session: SandboxSession,
  description: string,
  signal: AbortSignal,
): Promise<SandboxToolRequest | undefined> {
  const generationTimeoutMs = 120_000;
  const panel = presentPanel<RecipeGenerationResult>(
    ctx,
    (tui, theme, _keys, done) => {
      const loader = new BorderedLoader(
        tui,
        theme,
        `Preparing ${description} installation recipe…`,
      );
      loader.onAbort = () => done({ status: "cancelled" });
      const generationSignal = AbortSignal.any([
        signal,
        loader.signal,
        AbortSignal.timeout(generationTimeoutMs),
      ]);
      generateSandboxToolRecipe(ctx, session, description, generationSignal).then(
        (request) => done({ status: "generated", request }),
        (error) => done({ status: "failed", error }),
      );
      return loader;
    },
    { signal },
  );
  const result = await panel.result;
  signal.throwIfAborted();
  if (!result || result.status === "cancelled") {
    return undefined;
  }
  if (result.status === "failed") {
    throw result.error;
  }
  return result.request;
}

export async function addSandboxToolFromSettings(
  ctx: ExtensionContext,
  agentDir: string,
  getSession: () => SandboxSession,
  scope: "global" | "project",
  signal: AbortSignal,
): Promise<void> {
  if (!ctx.isIdle()) {
    throw new Error("Wait for the agent to finish before installing a tool");
  }
  if (!ctx.model) {
    throw new Error("Select a model before generating a tool recipe");
  }
  const description = await inputPanel(
    ctx,
    "Tool name (optional version or requirements)",
    "",
    signal,
  );
  signal.throwIfAborted();
  if (!description?.trim()) {
    return;
  }
  const session = getSession();
  if (!session.options.resolved.layers) {
    throw new Error("Settings tool installation requires a layered sandbox; reload first");
  }
  const project = await resolveSandboxProject(ctx.cwd, agentDir);
  if (project.id !== session.options.resolved.project.id) {
    throw new Error("The settings project differs from the running sandbox; reload first");
  }
  const sessionRevision = session.revision;
  const request = await generateWithProgress(ctx, session, description.trim(), signal);
  if (!request) {
    return;
  }
  if (!ctx.isIdle() || getSession() !== session || session.revision !== sessionRevision) {
    throw new Error("The sandbox changed while preparing the recipe; retry the installation");
  }
  const result = await requestSandboxTool(session, request, signal, undefined, undefined, scope);
  ctx.ui.notify(`Installed ${result.tool} (${result.requestedVersion}) in ${scope} tools.`, "info");
}
