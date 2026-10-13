import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { editConfigDraft } from "@paulsteele/pi-shared-ui";
import { resolveSandboxProject } from "./definition.ts";
import {
  defaultToolProfile,
  globalToolProfilePath,
  projectToolProfilePath,
  parseToolProfile,
  parseUniqueJson,
  resolveToolProfiles,
  loadToolProfile,
} from "./tool-profile.ts";
import { parseProjectEnvironment, projectEnvironmentPath } from "./project-environment.ts";
import { publishPrivateText, readPrivateText } from "./storage.ts";

export async function setupEnvironmentLayer(options: {
  agentDir: string;
  ctx: ExtensionCommandContext;
  kind: "global-tools" | "project-tools" | "project-environment";
}): Promise<void> {
  const { ctx, agentDir, kind } = options;
  const project = await resolveSandboxProject(ctx.cwd, agentDir);
  let path: string;
  let emptyDraft;
  if (kind === "global-tools") {
    path = globalToolProfilePath(agentDir);
    emptyDraft = defaultToolProfile();
  } else if (kind === "project-tools") {
    path = projectToolProfilePath(agentDir, project);
    emptyDraft = parseToolProfile({ version: 1, tools: {}, exclude: [] });
  } else {
    path = projectEnvironmentPath(agentDir, project);
    emptyDraft = parseProjectEnvironment({ version: 1 });
  }
  const stored = await readPrivateText(path);
  const text = await editConfigDraft(
    ctx,
    `Private environment configuration\n${path}`,
    stored?.text ?? JSON.stringify(emptyDraft, null, 2),
    ctx.signal,
  );
  if (text === undefined) {
    return;
  }
  const parsed = parseUniqueJson(text);
  const value =
    kind === "project-environment" ? parseProjectEnvironment(parsed) : parseToolProfile(parsed);
  if (kind === "global-tools") {
    resolveToolProfiles(value as ReturnType<typeof parseToolProfile>);
  }
  if (kind === "project-tools") {
    const global = await loadToolProfile(globalToolProfilePath(agentDir));
    if (!global) {
      throw new Error("Configure global tools with /sandbox setup global tools first");
    }
    resolveToolProfiles(global.profile, value as ReturnType<typeof parseToolProfile>);
  }
  const scope =
    kind === "global-tools"
      ? "Shared by all projects. All five language servers and their supporting runtimes are included."
      : "Private to this project and its linked worktrees. The selected base definition is unchanged.";
  const approved = await ctx.ui.confirm(
    "Save environment configuration?",
    `${path}\n${scope}\nSave the draft from your editor. Builds run inside container images. Reload/rebuild adopts these settings; running sessions are not restarted automatically. No host access is granted.`,
  );
  if (!approved) {
    return;
  }
  ctx.signal?.throwIfAborted();
  await publishPrivateText(path, `${JSON.stringify(value, null, 2)}\n`, stored?.revision);
  ctx.ui.notify(`Saved ${path}. Reload to build and validate the effective environment.`, "info");
}
