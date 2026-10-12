import { dirname, join, relative } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";
import type { SandboxSession } from "./session.ts";
import {
  devcontainerDefinitionSchema,
  resolveDefinition,
  type DevcontainerDefinition,
} from "./definition.ts";
import { imageDetailsSchema } from "./metadata-policy.ts";
import { podmanOutput } from "./driver.ts";
import { publishPrivateText, readPrivateText, sha256Hex } from "./storage.ts";

import {
  imageToolInstallationSchema,
  installationInstruction,
  type ImageToolInstallation,
} from "./image-tool-recipe.ts";

import { planProfileToolInstallation } from "./profile-tool-installation.ts";

export type { ImageToolInstallation } from "./image-tool-recipe.ts";
export interface ImageToolsProposal {
  preview: string;
  apply(signal: AbortSignal): Promise<void>;
}

export function imageToolsDefinition(options: {
  definition: DevcontainerDefinition;
  baseRecipe?: string;
  baseImage?: string;
  buildContext?: string;
  imageUser: string;
  installations: ImageToolInstallation[];
  recipePath: string;
}): { definition: DevcontainerDefinition; recipe: string } {
  const { definition, imageUser, installations } = options;
  if (!/^[a-zA-Z0-9_.:-]+$/.test(imageUser)) {
    throw new Error("Unsupported image user for tool build layer");
  }
  const base = options.baseRecipe ?? `FROM ${options.baseImage ?? definition.image}\n`;
  const selectedTarget = definition.build?.target;
  if (selectedTarget && !/^[a-zA-Z0-9_.-]+$/.test(selectedTarget)) {
    throw new Error("Unsupported build target for tool build layer");
  }
  const recipe = [
    base.trimEnd(),
    ...(selectedTarget ? [`FROM ${selectedTarget} AS pi_sandbox_tools`] : []),
    "USER root",
    ...installations.map(installationInstruction),
    `USER ${imageUser}`,
    "",
  ].join("\n");
  const {
    image: _image,
    dockerFile: _dockerFile,
    context: _context,
    build: priorBuild,
    ...preserved
  } = definition;
  const { target: _target, ...build } = priorBuild ?? {};
  const priorTools = definition.customizations?.["pi-quality-image-tools"];
  const receipts = Array.isArray(priorTools) ? priorTools : [];
  return {
    recipe,
    definition: {
      ...preserved,
      build: { ...build, dockerfile: options.recipePath, context: options.buildContext ?? "." },
      customizations: {
        ...definition.customizations,
        "pi-quality-image-tools": [
          ...receipts,
          ...installations.map((tool) => sha256Hex(JSON.stringify(tool))),
        ],
      },
    },
  };
}

export async function planImageTools(
  session: SandboxSession,
  requested: ImageToolInstallation[],
  signal: AbortSignal,
): Promise<ImageToolsProposal | undefined> {
  signal.throwIfAborted();
  const tools = z.array(imageToolInstallationSchema).max(32).parse(requested);
  if (session.options.resolved.layers) {
    return planProfileToolInstallation(session, tools, signal);
  }
  const resolved = session.options.resolved;
  const current = await resolveDefinition({
    selected: resolved,
    hostEnvironment: session.options.hostEnvironment,
    signal,
  });
  if (current.revision !== resolved.revision) {
    throw new Error("Active devcontainer definition changed; reload before proposing image tools");
  }
  const receipts = resolved.definition.customizations?.["pi-quality-image-tools"];
  const installations = tools.filter(
    (tool) => !Array.isArray(receipts) || !receipts.includes(sha256Hex(JSON.stringify(tool))),
  );
  if (!installations.length) {
    return undefined;
  }
  const image = imageDetailsSchema.parse(
    JSON.parse(
      await podmanOutput(["inspect", "--type", "image", session.environment.image], signal),
    )[0],
  );
  const baseRecipe = resolved.containerfile
    ? (await readPrivateText(resolved.containerfile))?.text
    : undefined;
  if (resolved.containerfile && !baseRecipe) {
    throw new Error("Active Containerfile disappeared before image-tool proposal");
  }
  const sourceErrors: ParseError[] = [];
  const sourceValue = parse(resolved.sourceText, sourceErrors, { allowTrailingComma: true });
  if (sourceErrors.length) {
    throw new Error("Cannot update invalid devcontainer JSONC");
  }
  const sourceDefinition = devcontainerDefinitionSchema.parse(sourceValue);
  const recipeName = `Containerfile.tools-${sha256Hex(JSON.stringify([resolved.revision, installations])).slice(0, 16)}`;
  const recipePath = join(dirname(resolved.path), recipeName);
  const proposal = imageToolsDefinition({
    definition: sourceDefinition,
    baseRecipe,
    baseImage: resolved.definition.image,
    buildContext: sourceDefinition.build?.context ?? sourceDefinition.context,
    imageUser: image.Config.User || "root",
    installations,
    recipePath: relative(dirname(resolved.path), recipePath),
  });
  const previousText = await readPrivateText(resolved.path);
  if (!previousText) {
    throw new Error("Active devcontainer definition disappeared before image-tool proposal");
  }
  const authorityRevision = session.revision;
  return {
    preview: [
      `Update active ${resolved.tier} devcontainer: ${resolved.path}`,
      resolved.tier === "global"
        ? "This global definition also affects future projects using the default."
        : "Other sessions using this definition see the updated recipe on creation/rebuild.",
      `Generated image recipe: ${recipePath}`,
      "Rebuild discards container-local changes; approved host binds are preserved. Installation prerequisites must already exist in the base image.",
      JSON.stringify(proposal.definition, null, 2),
      proposal.recipe,
    ].join("\n\n"),
    async apply(applySignal) {
      applySignal.throwIfAborted();
      if (
        session.revision !== authorityRevision ||
        (
          await resolveDefinition({
            selected: resolved,
            hostEnvironment: session.options.hostEnvironment,
            signal: applySignal,
          })
        ).revision !== resolved.revision
      ) {
        throw new Error("Sandbox or devcontainer definition changed since image-tool proposal");
      }
      const priorRecipe = await readPrivateText(recipePath);
      if (priorRecipe && priorRecipe.text !== proposal.recipe) {
        throw new Error("Generated tool Containerfile conflicts with an existing file");
      }
      if (!priorRecipe) {
        await publishPrivateText(recipePath, proposal.recipe, undefined);
      }
      const publishedRevision = await publishPrivateText(
        resolved.path,
        `${JSON.stringify(proposal.definition, null, 2)}\n`,
        previousText.revision,
      );
      try {
        const replacement = await resolveDefinition({
          selected: resolved,
          hostEnvironment: session.options.hostEnvironment,
          signal: applySignal,
        });
        await session.rebuildFromDefinition(replacement, applySignal);
      } catch (error) {
        await publishPrivateText(resolved.path, previousText.text, publishedRevision);
        throw error;
      }
    },
  };
}
