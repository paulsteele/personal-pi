import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { devcontainerDefinitionSchema } from "./definition.ts";
import { isPathInside, sha256Hex, readPrivateText, withPrivateLock } from "./storage.ts";

const companionFilesSchema = z.record(z.string().min(1).max(4096), z.string().max(256_000));
const setupDraftSchema = z
  .object({
    definition: devcontainerDefinitionSchema,
    files: companionFilesSchema.default({}),
    explanation: z.string().min(1).max(8000),
  })
  .strict();
export type DevcontainerSetupDraft = z.output<typeof setupDraftSchema>;

export function validateSetupDraft(value: unknown): DevcontainerSetupDraft {
  const draft = setupDraftSchema.parse(value);
  if (Object.keys(draft.files).length > 16) {
    throw new Error("Devcontainer setup draft has more than 16 companion files");
  }
  for (const path of Object.keys(draft.files)) {
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").includes("..") ||
      path === "devcontainer.json"
    ) {
      throw new Error(`Invalid setup companion-file path: ${path}`);
    }
  }
  const recipe = draft.definition.build?.dockerfile ?? draft.definition.dockerFile;
  const context = draft.definition.build?.context ?? draft.definition.context;
  const isSafeRelativePath = (path: string) =>
    !isAbsolute(path) && !path.includes("\\") && !path.split("/").includes("..");
  if (Object.keys(draft.files).length && recipe) {
    const hasSafeRecipePath = isSafeRelativePath(recipe);
    const hasSafeContextPath = context === undefined || isSafeRelativePath(context);
    const recipeIsSupplied = Object.hasOwn(draft.files, recipe);
    if (!hasSafeRecipePath || !hasSafeContextPath || !recipeIsSupplied) {
      throw new Error("Setup build recipe/context must refer to supplied relative companion files");
    }
  }
  if (Buffer.byteLength(JSON.stringify(draft)) > 1024 * 1024) {
    throw new Error("Devcontainer setup draft exceeds 1 MiB");
  }
  return draft;
}

export async function publishApprovedSetupDraft(options: {
  target: string;
  draft: DevcontainerSetupDraft;
  expectedRevision?: string;
  confirm: (preview: string) => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<void> {
  const draft = validateSetupDraft(options.draft);
  const preview = `${options.target}\n${draft.explanation}\n${JSON.stringify(draft, null, 2)}`;
  if (!(await options.confirm(preview))) {
    throw new Error("Devcontainer setup approval cancelled");
  }
  options.signal?.throwIfAborted();
  await withPrivateLock(`${options.target}.lock`, async () => {
    if ((await readPrivateText(options.target))?.revision !== options.expectedRevision) {
      throw new Error("Devcontainer definition changed during setup approval");
    }
    const directory = dirname(options.target);
    const generation = `files-${randomUUID()}`;
    const companionDirectory = join(directory, generation);
    await mkdir(companionDirectory, { mode: 0o700 });
    for (const [path, content] of Object.entries(draft.files)) {
      const destination = resolve(companionDirectory, path);
      if (!isPathInside(companionDirectory, destination)) {
        throw new Error("Setup file escaped its private generation");
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, content, { mode: 0o600, flag: "wx" });
    }
    const definition = { ...draft.definition };
    const hasCompanionFiles = Object.keys(draft.files).length > 0;
    if (definition.build && hasCompanionFiles) {
      definition.build = {
        ...definition.build,
        dockerfile: `${generation}/${definition.build.dockerfile}`,
        context: `${generation}/${definition.build.context ?? "."}`,
      };
    }
    if (definition.dockerFile && hasCompanionFiles) {
      definition.dockerFile = `${generation}/${definition.dockerFile}`;
      definition.context = `${generation}/${definition.context ?? "."}`;
    }
    options.signal?.throwIfAborted();
    const text = `${JSON.stringify(definition, null, 2)}\n`;
    const temporary = `${options.target}.${sha256Hex(text)}.tmp`;
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await rename(temporary, options.target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  });
}
