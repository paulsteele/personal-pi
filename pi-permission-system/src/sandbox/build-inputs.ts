import { basename, dirname, join } from "node:path";
import { lstat, readdir, realpath } from "node:fs/promises";
import { canonicalPath, isPathInside } from "./storage.ts";

export async function authorizeBuildInputs(options: {
  projectRoot: string;
  definitionPath: string;
  containerfile?: string;
  buildContext?: string;
  privateStorage: string;
  confirm?(preview: string): Promise<boolean>;
  signal?: AbortSignal;
}): Promise<void> {
  const projectRoot = await realpath(options.projectRoot);
  const definitionDirectory = await realpath(dirname(options.definitionPath));
  const privateStorage = await canonicalPath(options.privateStorage);
  const protectedAuthorityFileNames = new Set([
    "session.json",
    "owner.lock",
    "config.json",
    "host-commands.json",
    "auth.json",
    "tools.json",
    "environment.json",
    "project-environment.json",
    "definition-approval.json",
  ]);
  const definitionIsPrivate = isPathInside(privateStorage, options.definitionPath);
  const assertNoPrivateAuthority = (path: string) => {
    const isInsidePrivateStorage = isPathInside(privateStorage, path);
    const isOwnedRecipe = definitionIsPrivate && isPathInside(definitionDirectory, path);
    const containsPrivateStorage = isPathInside(path, privateStorage);
    const isProtectedAuthorityFile = protectedAuthorityFileNames.has(basename(path));
    if (
      containsPrivateStorage ||
      (isInsidePrivateStorage && (!isOwnedRecipe || isProtectedAuthorityFile))
    ) {
      throw new Error(`Build input exposes private sandbox authority: ${path}`);
    }
  };
  let inspectedEntries = 0;
  const inspectBuildInput = async (path: string): Promise<void> => {
    options.signal?.throwIfAborted();
    if (++inspectedEntries > 20_000) {
      throw new Error("Build input exceeds 20,000 entries; use a narrower context");
    }
    assertNoPrivateAuthority(path);
    const identity = await lstat(path);
    if (identity.isSymbolicLink()) {
      assertNoPrivateAuthority(await canonicalPath(path));
      return;
    }
    if (identity.isDirectory()) {
      for (const entry of await readdir(path)) {
        await inspectBuildInput(join(path, entry));
      }
    }
  };
  for (const input of [options.containerfile, options.buildContext]) {
    if (!input) {
      continue;
    }
    options.signal?.throwIfAborted();
    const path = await realpath(input);
    const identity = await lstat(path, { bigint: true });
    assertNoPrivateAuthority(path);
    const isOwnedRecipe = definitionIsPrivate && isPathInside(definitionDirectory, path);
    const insideApprovedSource = isPathInside(projectRoot, path) || isOwnedRecipe;
    if (!insideApprovedSource) {
      const approved = await options.confirm?.(
        `Read external host build input?\n${path}\nBuild inputs can be copied into the image. Runtime mounts do not authorize these reads.`,
      );
      if (!approved) {
        throw new Error(`External host build input is not authorized: ${path}`);
      }
    }
    await inspectBuildInput(path);
    options.signal?.throwIfAborted();
    const current = await lstat(path, { bigint: true });
    if (
      (await realpath(input)) !== path ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) {
      throw new Error(`Build input changed during approval: ${path}`);
    }
  }
}
