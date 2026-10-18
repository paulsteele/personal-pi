import { join } from "node:path";
import { unlink } from "node:fs/promises";
import type { SandboxSession } from "./session.ts";
import type { ImageToolInstallation } from "./image-tool-recipe.ts";
import { buildContentKey } from "./tool-cache.ts";
import { managedCatalogTool } from "./tool-catalog.ts";
import {
  globalToolProfilePath,
  loadToolProfile,
  parseToolProfile,
  projectToolProfilePath,
  resolveToolProfiles,
  type ToolProfileEntry,
} from "./tool-profile.ts";
import { resolveDefinition } from "./definition.ts";
import { publishPrivateText, readPrivateText, sha256Hex, withPrivateLock } from "./storage.ts";
import { validateEnvironmentSources } from "./environment-layers.ts";
import { prerequisiteProviderIds } from "./tool-prerequisites.ts";

function profileEntry(
  installation: ImageToolInstallation,
  dependencies: string[],
): ToolProfileEntry {
  const { id, ...recipe } = installation;
  const managedTool = managedCatalogTool(id, installation.version);
  if (managedTool) {
    return { kind: "catalog", version: managedTool.version };
  }
  return { kind: "recipe", ...recipe, dependencies };
}

export async function planProfileToolInstallation(
  session: SandboxSession,
  installations: ImageToolInstallation[],
  signal: AbortSignal,
  scope: "global" | "project" = "project",
): Promise<{ preview: string; apply(signal: AbortSignal): Promise<void> } | undefined> {
  signal.throwIfAborted();
  const resolved = session.options.resolved;
  const layers = resolved.layers;
  if (!layers) {
    throw new Error("Tool profile installation requires a layered environment");
  }
  await validateEnvironmentSources(layers);
  const path =
    scope === "global"
      ? globalToolProfilePath(session.options.agentDir)
      : projectToolProfilePath(session.options.agentDir, resolved.project);
  const previous = await readPrivateText(path);
  const stored = await loadToolProfile(path);
  const profile = stored?.profile ?? parseToolProfile({ version: 1, tools: {}, exclude: [] });
  let changed = false;
  const existingTools = resolveToolProfiles(
    layers.globalTools.profile,
    layers.projectTools?.profile,
  );
  for (const installation of installations) {
    const id = installation.id;
    const existingPrerequisiteProviderIds = prerequisiteProviderIds(
      installation.prerequisites,
      existingTools.filter((tool) => tool.id !== id),
    );
    const next = profileEntry(installation, existingPrerequisiteProviderIds);
    if (profile.tools[id] && buildContentKey(profile.tools[id]) === buildContentKey(next)) {
      continue;
    }
    profile.tools[id] = next;
    profile.exclude = profile.exclude.filter((excluded) => excluded !== id);
    changed = true;
  }
  if (!changed) {
    return undefined;
  }
  const globalProfile = scope === "global" ? profile : layers.globalTools.profile;
  const projectProfile = scope === "project" ? profile : layers.projectTools?.profile;
  const candidateTools = resolveToolProfiles(globalProfile, projectProfile);
  if (scope === "global") {
    for (const installation of installations) {
      const isInstalledFromGlobalProfile =
        candidateTools.find((tool) => tool.id === installation.id)?.source === "global";
      if (!isInstalledFromGlobalProfile) {
        throw new Error(
          `Project tools override or exclude ${installation.id}; edit the project profile before installing it globally in this session`,
        );
      }
    }
  }
  const nextText = `${JSON.stringify(profile, null, 2)}\n`;
  const authorityRevision = session.revision;
  return {
    preview: [
      `Save private ${scope} tools: ${path}`,
      ...(scope === "global"
        ? [
            "This global profile also affects future builds in other projects. Running sessions are unchanged.",
          ]
        : []),
      `Base definition stays unchanged: ${resolved.path}`,
      "Shared global artifacts remain cached. Rebuild discards container-local changes and preserves approved host binds.",
      nextText,
    ].join("\n\n"),
    async apply(applySignal) {
      applySignal.throwIfAborted();
      if (session.revision !== authorityRevision) {
        throw new Error("Sandbox changed since tool installation preview");
      }
      await validateEnvironmentSources(layers);
      const journalPath = join(session.directory, "tool-profile-transaction.json");
      if (await readPrivateText(journalPath)) {
        throw new Error(
          "An interrupted tool-profile transaction requires recovery before another installation",
        );
      }
      await publishPrivateText(
        journalPath,
        JSON.stringify({
          path,
          previousText: previous?.text ?? null,
          previousRevision: previous?.revision ?? null,
          nextText,
        }),
        undefined,
      );
      let publishedRevision: string | undefined;
      try {
        const current = await resolveDefinition({
          selected: resolved,
          agentDir: session.options.agentDir,
          hostEnvironment: session.options.hostEnvironment,
          signal: applySignal,
        });
        if (current.revision !== resolved.revision) {
          throw new Error("Base or environment sources changed since the installation preview");
        }
        const candidateProfile = { path, revision: sha256Hex(nextText), profile };
        const candidateLayers = {
          ...layers,
          tools: candidateTools,
          globalTools: scope === "global" ? candidateProfile : layers.globalTools,
          projectTools: scope === "project" ? candidateProfile : layers.projectTools,
          revision: buildContentKey([layers.revision, sha256Hex(nextText)]),
        };
        const replacement = {
          ...resolved,
          layers: candidateLayers,
          revision: sha256Hex(JSON.stringify([resolved.baseRevision, candidateLayers.revision])),
        };
        await session.rebuildFromDefinition(replacement, applySignal, {
          async commit() {
            await validateEnvironmentSources(layers);
            publishedRevision = await publishPrivateText(path, nextText, previous?.revision);
            const committed = await resolveDefinition({
              selected: resolved,
              agentDir: session.options.agentDir,
              hostEnvironment: session.options.hostEnvironment,
              signal: applySignal,
            });
            Object.assign(replacement, committed);
          },
          async rollback() {
            if (!publishedRevision) {
              return;
            }
            if (previous) {
              await publishPrivateText(path, previous.text, publishedRevision);
            } else {
              await withPrivateLock(`${path}.lock`, async () => {
                if ((await readPrivateText(path))?.revision !== publishedRevision) {
                  throw new Error(
                    "Tool profile changed during rollback; retained transaction journal for recovery",
                  );
                }
                await unlink(path);
              });
            }
            publishedRevision = undefined;
          },
        });
      } catch (error) {
        if (publishedRevision && previous) {
          await publishPrivateText(path, previous.text, publishedRevision);
        } else if (publishedRevision) {
          await withPrivateLock(`${path}.lock`, async () => {
            if ((await readPrivateText(path))?.revision !== publishedRevision) {
              throw new Error(
                "Tool profile changed during rollback; retained transaction journal for recovery",
              );
            }
            await unlink(path);
          });
        }
        await unlink(journalPath);
        throw error;
      }
      await unlink(journalPath);
    },
  };
}
