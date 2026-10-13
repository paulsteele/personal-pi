import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { editConfigDraft } from "@paulsteele/pi-shared-ui";
import {
  globalDefinitionPath,
  projectDefinitionPath,
  resolveSandboxProject,
} from "./definition.ts";
import { loadSandboxSettings, saveSandboxSettings } from "./settings.ts";
import { publishApprovedSetupDraft, validateSetupDraft } from "./setup.ts";
import { readPrivateText } from "./storage.ts";
import { setupEnvironmentLayer } from "./layer-setup.ts";

export async function handleSandboxSetup(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) {
    throw new Error("Devcontainer setup requires interactive operator approval");
  }
  await ctx.waitForIdle();
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const agentDir = getAgentDir();
  const settings = await loadSandboxSettings(agentDir);
  if (settings.needsMigration) {
    const migrationApproved = await ctx.ui.confirm(
      "Migrate permission settings to mandatory sandboxing?",
      "Retain policy; remove classifier settings and all auto-mode controls.",
    );
    if (!migrationApproved) {
      throw new Error("Sandbox settings migration cancelled");
    }
    await saveSandboxSettings(agentDir, settings.settings, settings.revision, ctx.signal);
  }
  if (args === "global tools" || args === "tools" || args === "" || args === "update") {
    const kind =
      args === "global tools"
        ? "global-tools"
        : args === "tools"
          ? "project-tools"
          : "project-environment";
    await setupEnvironmentLayer({ agentDir, ctx, kind });
    return;
  }
  if (args !== "global" && args !== "base") {
    throw new Error("Use /sandbox setup [global|global tools|tools|base|update]");
  }
  await setupContainerBase({
    agentDir,
    ctx,
    scope: args === "global" ? "global" : "project",
  });
}

export async function setupContainerBase(options: {
  agentDir: string;
  ctx: ExtensionContext;
  scope: "global" | "project";
}): Promise<void> {
  const { agentDir, ctx, scope } = options;
  if (!ctx.hasUI) {
    throw new Error("Devcontainer setup requires interactive operator approval");
  }
  ctx.signal?.throwIfAborted();
  const project = await resolveSandboxProject(ctx.cwd, agentDir);
  const target =
    scope === "global" ? globalDefinitionPath(agentDir) : projectDefinitionPath(agentDir, project);
  const prior = await readPrivateText(target);
  const draft = prior
    ? {
        definition: JSON.parse(prior.text),
        files: {},
        explanation: "Operator-defined devcontainer",
      }
    : {
        definition: { build: { dockerfile: "Containerfile" } },
        files: {
          Containerfile:
            "FROM docker.io/library/node:24-bookworm\nRUN apt-get update && apt-get install -y --no-install-recommends bash git ripgrep python3 ca-certificates\n",
        },
        explanation: "Base development environment",
      };
  const edited = await editConfigDraft(
    ctx,
    `Edit devcontainer setup\n${target}`,
    JSON.stringify(draft, null, 2),
    ctx.signal,
  );
  if (edited === undefined) {
    return;
  }
  await publishApprovedSetupDraft({
    target,
    draft: validateSetupDraft(JSON.parse(edited)),
    expectedRevision: prior?.revision,
    confirm: () =>
      ctx.ui.confirm(
        "Write this devcontainer definition?",
        `${target}\nSave the edited definition and its companion files. Build, host initialization, and additional mounts remain separately approved.`,
      ),
    signal: ctx.signal,
  });
  ctx.ui.notify(
    `Devcontainer definition written to ${target}. Build, host initialization, and additional mounts still require validation/approval.`,
    "info",
  );
}
