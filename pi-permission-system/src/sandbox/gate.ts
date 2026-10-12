import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { posix } from "node:path";
import { checkPolicy } from "../policy.ts";
import { BashProgram } from "../access-intent/bash/program.ts";
import { PathNormalizer } from "../path-normalizer.ts";
import { evaluateSafety, type SafetyContext } from "../auto/safety-policy.ts";
import type { SandboxSession } from "./session.ts";
import { loadSandboxSettings } from "./settings.ts";
import { guestToHost } from "./mounts.ts";

const guestTools = new Set([
  "read",
  "edit",
  "write",
  "bash",
  "grep",
  "find",
  "ls",
  "request_host_mount",
  "request_sandbox_tool",
]);
const infrastructureTools = new Map([
  ["quality_response", "code-quality/index.ts"],
  ["pr_review", "pr-review/index.ts"],
  ["pr_review_result", "pr-review/index.ts"],
]);
const authorizedHostPackages = [
  {
    sourcePattern: /^npm:pi-web-access(?:@[^/]+)?$/,
    entrySuffixes: [
      "/node_modules/pi-web-access/index.ts",
      "/node_modules/pi-web-access/dist/index.js",
    ],
    toolNames: new Set(["web_search", "source_check", "fetch_content", "get_search_content"]),
  },
  {
    sourcePattern: /^npm:@plannotator\/pi-extension(?:@[^/]+)?$/,
    entrySuffixes: ["/node_modules/@plannotator/pi-extension/index.ts"],
    toolNames: new Set(["plannotator", "plannotator_submit_plan", "plannotator_mark_done"]),
  },
];
export const externalEffectCategories = new Set([
  "vcs_remote_mutation",
  "package_publication",
  "artifact_publication",
  "deployment_mutation",
  "cloud_or_deployment_mutation",
  "cluster_mutation",
  "cluster_release_mutation",
  "infrastructure_mutation",
  "container_or_registry_mutation",
  "credential_helper_access",
  "credential_store_access",
  "secret_key_export",
  "kernel_keyring_access",
  "sensitive_path",
  "macos_keychain_access",
]);

export function isAuditedHostUiTool(tool: ToolInfo): boolean {
  return (
    tool.name === "ask_user_question" &&
    tool.sourceInfo.origin === "package" &&
    /^npm:@juicesharp\/rpiv-ask-user-question(?:@[^/]+)?$/.test(tool.sourceInfo.source) &&
    tool.sourceInfo.path.endsWith("/node_modules/@juicesharp/rpiv-ask-user-question/index.ts")
  );
}

export function isAuthorizedHostTool(tool: ToolInfo): boolean {
  if (isAuditedHostUiTool(tool)) {
    return true;
  }
  if (tool.sourceInfo.origin !== "package") {
    return false;
  }
  return authorizedHostPackages.some(
    (owner) =>
      owner.toolNames.has(tool.name) &&
      owner.sourcePattern.test(tool.sourceInfo.source) &&
      owner.entrySuffixes.some((suffix) => tool.sourceInfo.path.endsWith(suffix)),
  );
}

export function isAuditedSandboxTool(tool: ToolInfo): boolean {
  if (isAuthorizedHostTool(tool)) {
    return true;
  }
  if (guestTools.has(tool.name)) {
    return (
      tool.sourceInfo.path.endsWith("/pi-permission-system/src/index.ts") ||
      tool.sourceInfo.path.endsWith("/pi-permission-system/src/sandbox-extension.ts")
    );
  }
  const source = infrastructureTools.get(tool.name);
  if (source) {
    return tool.sourceInfo.path.endsWith(`/${source}`);
  }
  return (
    tool.sourceInfo.path === "builtin:codemode" || tool.sourceInfo.path === "builtin:tool-search"
  );
}

export async function reviewSandboxToolCall(options: {
  tool: ToolInfo | undefined;
  getSession: () => SandboxSession;
  agentDir: string;
  input: Record<string, unknown>;
  toolCallId: string;
  ctx: ExtensionContext;
  confirm: (context: SafetyContext, category: string, reason: string) => Promise<boolean>;
}): Promise<void> {
  const { tool } = options;
  if (!tool || !isAuditedSandboxTool(tool)) {
    throw new Error("Tool is not integrated with the mandatory sandbox boundary");
  }
  if (isAuthorizedHostTool(tool)) {
    const { settings } = await loadSandboxSettings(options.agentDir);
    if (checkPolicy(settings.permission, tool.name, tool.name).state === "deny") {
      throw new Error("Tool denied by explicit policy");
    }
    options.ctx.signal?.throwIfAborted();
    return;
  }
  await reviewSandboxAction({
    session: options.getSession(),
    agentDir: options.agentDir,
    toolName: tool.name,
    input: options.input,
    toolCallId: options.toolCallId,
    ctx: options.ctx,
    confirm: options.confirm,
  });
}

export async function reviewSandboxAction(options: {
  session: SandboxSession;
  canonicalGuestPath?: string;
  agentDir: string;
  toolName: string;
  input: Record<string, unknown>;
  toolCallId: string;
  ctx: ExtensionContext;
  confirm: (context: SafetyContext, category: string, reason: string) => Promise<boolean>;
}): Promise<void> {
  const { session, input, toolName } = options;
  const settings = await loadSandboxSettings(options.agentDir);
  if (settings.needsMigration) {
    throw new Error(
      "Migrate legacy permission settings with /sandbox setup before executing tools",
    );
  }
  const permission = settings.settings.permission;
  const deniesTool = checkPolicy(permission, toolName, toolName).state === "deny";
  if (deniesTool) {
    throw new Error("Tool denied by explicit policy");
  }
  const defaultsPathToCurrentDirectory = ["grep", "find", "ls"].includes(toolName);
  if (defaultsPathToCurrentDirectory && input.path === undefined) {
    input.path = ".";
  }
  const reviewedAuthorityRevision = session.revision;
  const workspace = session.environment.workspace;
  const needsGuestHome = toolName === "bash" || typeof input.path === "string";
  let guestHome = session.environment.remoteEnvironment?.HOME;
  if (!guestHome && needsGuestHome) {
    guestHome = await session.filesystem.canonical("~", options.ctx.signal);
  }
  guestHome ??= "";
  const pathPolicyAliases = (inputPath: string, canonicalGuestPath: string): string[] => {
    const guestHomeExpandedPath = inputPath.replace(/^~(?=\/|$)/, guestHome);
    const lexicalGuestPath = posix.resolve(workspace, guestHomeExpandedPath);
    const workspaceRelativePath = posix.relative(workspace, lexicalGuestPath);
    const guestPathAliases = [workspaceRelativePath, lexicalGuestPath, canonicalGuestPath];
    const lexicalHostPathAlias = guestToHost(lexicalGuestPath, session.mounts);
    const canonicalHostPathAlias = guestToHost(canonicalGuestPath, session.mounts);
    const hostPathAliases = [lexicalHostPathAlias, canonicalHostPathAlias];
    return [...new Set([inputPath, ...guestPathAliases, ...hostPathAliases].filter(
      (value): value is string => typeof value === "string",
    ))];
  };
  let path: string | undefined;
  if (typeof input.path === "string") {
    path = options.canonicalGuestPath;
    if (path === undefined) {
      path = await session.filesystem.canonical(input.path, options.ctx.signal);
    }
  }
  const pathAliases = path ? pathPolicyAliases(String(input.path), path) : [];
  for (const alias of pathAliases) {
    if (checkPolicy(permission, "path", alias).state === "deny") {
      throw new Error("Path denied by explicit policy");
    }
  }
  const command =
    toolName === "bash" && typeof input.command === "string" ? input.command : undefined;
  const program = command
    ? await BashProgram.parse(command, new PathNormalizer(workspace, "guest", guestHome), {
        probeGuestEntries: (paths) => session.filesystem.entriesExist(paths, options.ctx.signal),
      })
    : undefined;
  if (command && checkPolicy(permission, "bash", command).state === "deny") {
    throw new Error("Shell command denied by explicit policy");
  }
  for (const unit of program?.commands() ?? []) {
    if (checkPolicy(permission, "bash", unit.text).state === "deny") {
      throw new Error("Shell command denied by explicit policy");
    }
  }
  const shellPaths: string[] = [];
  for (const candidate of program?.pathRuleCandidates() ?? []) {
    const canonical = await session.filesystem.canonical(
      candidate.path.value(),
      options.ctx.signal,
    );
    const aliases = [...candidate.path.matchValues(), ...pathPolicyAliases(candidate.path.value(), canonical)];
    shellPaths.push(...aliases);
    if (aliases.some((alias) => checkPolicy(permission, "path", alias).state === "deny")) {
      throw new Error("Shell path denied by explicit policy");
    }
  }
  const paths = [...pathAliases, ...shellPaths];
  const hasUnresolvedFilesystemAccess = program?.hasUnresolvedPathExpression() === true;
  if (hasUnresolvedFilesystemAccess) {
    const confirmationContext: SafetyContext = {
      requestId: `sandbox-${options.toolCallId}`,
      toolCallId: options.toolCallId,
      toolName,
      agentName: null,
      input,
      cwd: workspace,
      platform: "linux",
      shell: null,
      paths: [],
      riskMarkers: ["unresolved-path-expression"],
    };
    const confirmationCategory = "unresolved_path";
    const confirmationReason = "Filesystem access contains an unresolved shell expansion";
    const approved = await options.confirm(
      confirmationContext,
      confirmationCategory,
      confirmationReason,
    );
    if (!approved) {
      throw new Error("Human denied unresolved filesystem access");
    }
  }
  const shellCommands = (program?.guardCommands() ?? []).map((unit) => ({
    text: unit.text,
    argv: unit.argv ?? null,
    context: unit.context ?? null,
    wrapperKind: unit.wrapperKind ?? null,
    executedUnit: unit.executedUnit ?? null,
  }));
  const shellContext = command
    ? {
        command,
        workdir: null,
        parseComplete: program?.isParseComplete() ?? false,
        unresolvedPathExpression: program?.hasUnresolvedPathExpression() ?? false,
        commands: shellCommands,
      }
    : null;
  const safetyPaths = paths.map((value) => ({
    value,
    matchValues: [value],
    boundaryValue: value,
    mountAliases: [],
    mountResolutionIncomplete: false,
  }));
  const context: SafetyContext = {
    requestId: `sandbox-${options.toolCallId}`,
    toolCallId: options.toolCallId,
    toolName,
    agentName: null,
    input,
    cwd: session.environment.workspace,
    platform: "linux",
    shell: shellContext,
    paths: safetyPaths,
    riskMarkers: [],
  };
  const safety = evaluateSafety(context, false, { home: guestHome }, (category) =>
    externalEffectCategories.has(category),
  );
  if (safety.kind === "require_human" && externalEffectCategories.has(safety.category)) {
    if (!(await options.confirm(context, safety.category, safety.reason))) {
      throw new Error("Human denied sensitive or external-effect operation");
    }
  }
  if (
    (await loadSandboxSettings(options.agentDir)).revision !== settings.revision ||
    session.revision !== reviewedAuthorityRevision
  ) {
    throw new Error(
      "Permission policy or sandbox authority changed during action review; retry the tool",
    );
  }
  options.ctx.signal?.throwIfAborted();
  if (path) {
    input.path = posix.normalize(path);
  }
}
