import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { posix, relative, resolve } from "node:path";
import { checkPolicy } from "../policy.ts";
import { BashProgram, type BashPathRuleCandidate } from "../access-intent/bash/program.ts";
import { PathNormalizer } from "../path-normalizer.ts";
import { canonicalizePath } from "../path/canonicalize-path.ts";
import { expandHomePath } from "../expand-home.ts";
import type { SandboxSession } from "./session.ts";
import { loadSandboxSettings, type SandboxSettings } from "./settings.ts";
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
    entrySuffixes: [
      "/node_modules/@plannotator/pi-extension/index.ts",
      "/node_modules/@plannotator/pi-extension",
    ],
    toolNames: new Set(["plannotator", "plannotator_submit_plan", "plannotator_mark_done"]),
  },
];
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
  isHostMode?: () => boolean;
  agentDir: string;
  input: Record<string, unknown>;
  ctx: ExtensionContext;
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
  if (options.isHostMode?.()) {
    await reviewHostAction({
      agentDir: options.agentDir,
      toolName: tool.name,
      input: options.input,
      ctx: options.ctx,
    });
    return;
  }
  await reviewSandboxAction({
    session: options.getSession(),
    agentDir: options.agentDir,
    toolName: tool.name,
    input: options.input,
    ctx: options.ctx,
  });
}

type PermissionPolicy = SandboxSettings["permission"];

async function loadEnforceablePolicy(
  agentDir: string,
): Promise<{ permission: PermissionPolicy; revision?: string }> {
  const settings = await loadSandboxSettings(agentDir);
  if (settings.needsMigration) {
    throw new Error(
      "Migrate legacy permission settings with /sandbox setup before executing tools",
    );
  }
  return { permission: settings.settings.permission, revision: settings.revision };
}

async function enforceExplicitDenies(review: {
  permission: PermissionPolicy;
  pathAliases: readonly string[];
  command: string | undefined;
  program: BashProgram | undefined;
  shellPathAliases(candidate: BashPathRuleCandidate): Promise<string[]>;
}): Promise<void> {
  const isDenied = (surface: string, value: string) =>
    checkPolicy(review.permission, surface, value).state === "deny";
  if (review.pathAliases.some((alias) => isDenied("path", alias))) {
    throw new Error("Path denied by explicit policy");
  }
  if (review.command && isDenied("bash", review.command)) {
    throw new Error("Shell command denied by explicit policy");
  }
  for (const unit of review.program?.commands() ?? []) {
    if (isDenied("bash", unit.text)) {
      throw new Error("Shell command denied by explicit policy");
    }
  }
  for (const candidate of review.program?.pathRuleCandidates() ?? []) {
    const aliases = await review.shellPathAliases(candidate);
    if (aliases.some((alias) => isDenied("path", alias))) {
      throw new Error("Shell path denied by explicit policy");
    }
  }
}

function assertToolAllowed(permission: PermissionPolicy, toolName: string): void {
  if (checkPolicy(permission, toolName, toolName).state === "deny") {
    throw new Error("Tool denied by explicit policy");
  }
}

function bashCommandInput(toolName: string, input: Record<string, unknown>): string | undefined {
  return toolName === "bash" && typeof input.command === "string" ? input.command : undefined;
}

export async function reviewSandboxAction(options: {
  session: SandboxSession;
  canonicalGuestPath?: string;
  agentDir: string;
  toolName: string;
  input: Record<string, unknown>;
  ctx: ExtensionContext;
}): Promise<void> {
  const { session, input, toolName } = options;
  const policy = await loadEnforceablePolicy(options.agentDir);
  assertToolAllowed(policy.permission, toolName);
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
    return [
      ...new Set(
        [inputPath, ...guestPathAliases, ...hostPathAliases].filter(
          (value): value is string => typeof value === "string",
        ),
      ),
    ];
  };
  let path: string | undefined;
  if (typeof input.path === "string") {
    path = options.canonicalGuestPath;
    if (path === undefined) {
      path = await session.filesystem.canonical(input.path, options.ctx.signal);
    }
  }
  const command = bashCommandInput(toolName, input);
  const program = command
    ? await BashProgram.parse(command, new PathNormalizer(workspace, "guest", guestHome), {
        probeGuestEntries: (paths) => session.filesystem.entriesExist(paths, options.ctx.signal),
      })
    : undefined;
  await enforceExplicitDenies({
    permission: policy.permission,
    pathAliases: path ? pathPolicyAliases(String(input.path), path) : [],
    command,
    program,
    shellPathAliases: async (candidate) => {
      const canonical = await session.filesystem.canonical(
        candidate.path.value(),
        options.ctx.signal,
      );
      return [
        ...candidate.path.matchValues(),
        ...pathPolicyAliases(candidate.path.value(), canonical),
      ];
    },
  });
  if (
    (await loadSandboxSettings(options.agentDir)).revision !== policy.revision ||
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

/** Enforces explicit denies for built-in tools running natively while the sandbox is off. */
export async function reviewHostAction(options: {
  agentDir: string;
  toolName: string;
  input: Record<string, unknown>;
  ctx: ExtensionContext;
}): Promise<void> {
  const { input, toolName, ctx } = options;
  const policy = await loadEnforceablePolicy(options.agentDir);
  assertToolAllowed(policy.permission, toolName);
  const hostPathAliases = (inputPath: string): string[] => {
    const lexicalHostPath = resolve(ctx.cwd, expandHomePath(inputPath));
    const cwdRelativePath = relative(ctx.cwd, lexicalHostPath);
    return [
      ...new Set([inputPath, cwdRelativePath, lexicalHostPath, canonicalizePath(lexicalHostPath)]),
    ];
  };
  const command = bashCommandInput(toolName, input);
  const program = command
    ? await BashProgram.parse(command, new PathNormalizer(ctx.cwd, "host"))
    : undefined;
  await enforceExplicitDenies({
    permission: policy.permission,
    pathAliases: typeof input.path === "string" ? hostPathAliases(input.path) : [],
    command,
    program,
    shellPathAliases: async (candidate) => [
      ...candidate.path.matchValues(),
      ...hostPathAliases(candidate.path.value()),
    ],
  });
  if ((await loadSandboxSettings(options.agentDir)).revision !== policy.revision) {
    throw new Error("Permission policy changed during action review; retry the tool");
  }
  ctx.signal?.throwIfAborted();
}
