import { publishPrivateText } from "./storage.ts";
import { MissingCatalogVersionError } from "./tool-catalog.ts";
import { loadToolProfile, parseToolProfile } from "./tool-profile.ts";

export async function switchProfileToolVersion(
  error: MissingCatalogVersionError,
  signal?: AbortSignal,
): Promise<void> {
  const { profilePath, replacementVersion } = error;
  if (!profilePath || !replacementVersion) {
    throw new Error(`No replacement version is available for ${error.toolId}`);
  }
  const stored = await loadToolProfile(profilePath);
  const entry = stored?.profile.tools[error.toolId];
  const entryStillRequestsMissingVersion =
    entry?.kind === "catalog" && entry.version === error.requestedVersion;
  if (!stored || !entryStillRequestsMissingVersion) {
    throw new Error(`${profilePath} changed since startup failed; reopen Sandbox Tools`);
  }
  const updated = parseToolProfile({
    ...stored.profile,
    tools: {
      ...stored.profile.tools,
      [error.toolId]: { kind: "catalog", version: replacementVersion },
    },
  });
  await publishPrivateText(
    profilePath,
    `${JSON.stringify(updated, null, 2)}\n`,
    stored.revision,
    signal,
  );
}

export type StartupRecoveryAction =
  | { kind: "retry"; label: string }
  | { kind: "rebuild"; label: string }
  | { kind: "switch-tool-version"; label: string; error: MissingCatalogVersionError }
  | { kind: "open-config"; label: string; path: string }
  | { kind: "show-log"; label: string }
  | { kind: "sandbox-off"; label: string }
  | { kind: "dismiss"; label: string };

export interface StartupFailureContext {
  globalToolsPath: string;
  projectToolsPath?: string;
  projectEnvironmentPath?: string;
  definitionPath?: string;
  hasStartupLog: boolean;
}

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current !== undefined && chain.length < 8; ) {
    chain.push(current);
    current = (current as { cause?: unknown })?.cause;
  }
  return chain;
}

function errorText(error: unknown): string {
  return causeChain(error).map(String).join("\n");
}

function missingCatalogVersion(error: unknown): MissingCatalogVersionError | undefined {
  return causeChain(error).find(
    (cause): cause is MissingCatalogVersionError => cause instanceof MissingCatalogVersionError,
  );
}

const missingPrerequisitePattern = /Missing image prerequisite: (\S+) for (\S+)/;
const toolProfileProblemPattern =
  /Managed tool requires|Missing tool dependency|Cannot exclude undeclared tool|Global tooling must include/;
const lifecycleProblemPattern =
  /postCreateCommand|onCreateCommand|postStartCommand|updateContentCommand|lifecycle/i;

function configurationPathFor(
  error: unknown,
  context: StartupFailureContext,
): { path: string; label: string } | undefined {
  const missingVersion = missingCatalogVersion(error);
  if (missingVersion?.profilePath) {
    return {
      path: missingVersion.profilePath,
      label: `Edit ${missingVersion.toolId} in its tool profile`,
    };
  }
  const text = errorText(error);
  const missingPrerequisite = text.match(missingPrerequisitePattern);
  if (missingPrerequisite) {
    const [, prerequisite, toolId] = missingPrerequisite;
    return {
      path: context.projectToolsPath ?? context.globalToolsPath,
      label: `Edit ${toolId} (needs ${prerequisite}) in Sandbox Tools`,
    };
  }
  if (toolProfileProblemPattern.test(text)) {
    return {
      path: context.projectToolsPath ?? context.globalToolsPath,
      label: "Open Sandbox Tools",
    };
  }
  if (lifecycleProblemPattern.test(text) && context.projectEnvironmentPath) {
    return { path: context.projectEnvironmentPath, label: "Open Project Environment" };
  }
  if (context.definitionPath) {
    return { path: context.definitionPath, label: "Open the devcontainer definition" };
  }
  return undefined;
}

export function startupRecoveryActions(
  error: unknown,
  context: StartupFailureContext,
): StartupRecoveryAction[] {
  const actions: StartupRecoveryAction[] = [];
  const missingVersion = missingCatalogVersion(error);
  if (missingVersion?.replacementVersion && missingVersion.profilePath) {
    actions.push({
      kind: "switch-tool-version",
      label: `Switch ${missingVersion.toolId} ${missingVersion.requestedVersion} → ${missingVersion.replacementVersion}`,
      error: missingVersion,
    });
  }
  actions.push({ kind: "retry", label: "Retry startup" });
  actions.push({ kind: "rebuild", label: "Rebuild (discard container state) and retry" });
  const configuration = configurationPathFor(error, context);
  if (configuration) {
    actions.push({ kind: "open-config", label: configuration.label, path: configuration.path });
  }
  if (context.hasStartupLog) {
    actions.push({ kind: "show-log", label: "Show the startup log path" });
  }
  actions.push({ kind: "sandbox-off", label: "Turn sandbox off for this session" });
  actions.push({ kind: "dismiss", label: "Leave the sandbox unavailable" });
  return actions;
}
