import { join } from "node:path";
import { unlink } from "node:fs/promises";
import type { SandboxSession } from "./session.ts";
import type { ImageToolInstallation } from "./image-tool-recipe.ts";
import { buildContentKey } from "./tool-cache.ts";
import {
  loadToolProfile,
  parseToolProfile,
  projectToolProfilePath,
  resolveToolProfiles,
} from "./tool-profile.ts";
import { resolveDefinition } from "./definition.ts";
import { publishPrivateText, readPrivateText, sha256Hex, withPrivateLock } from "./storage.ts";
import { validateEnvironmentSources } from "./environment-layers.ts";

export async function planProfileToolInstallation(
  session: SandboxSession,
  installations: ImageToolInstallation[],
  signal: AbortSignal,
): Promise<{ preview: string; apply(signal: AbortSignal): Promise<void> } | undefined> {
  signal.throwIfAborted();
  const resolved = session.options.resolved;
  const layers = resolved.layers;
  if (!layers) {
    throw new Error("Tool profile installation requires a layered environment");
  }
  await validateEnvironmentSources(layers);
  const path = projectToolProfilePath(session.options.agentDir, resolved.project);
  const previous = await readPrivateText(path);
  const stored = await loadToolProfile(path);
  const profile = stored?.profile ?? parseToolProfile({ version: 1, tools: {}, exclude: [] });
  let changed = false;
  for (const installation of installations) {
    const { id, ...recipe } = installation;
    const next = { kind: "recipe" as const, ...recipe, dependencies: [] };
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
  resolveToolProfiles(layers.globalTools.profile, profile);
  const nextText = `${JSON.stringify(profile, null, 2)}\n`;
  const authorityRevision = session.revision;
  return {
    preview: [
      `Save private project tools: ${path}`,
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
        const candidateLayers = {
          ...layers,
          tools: resolveToolProfiles(layers.globalTools.profile, profile),
          projectTools: { path, revision: sha256Hex(nextText), profile },
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
