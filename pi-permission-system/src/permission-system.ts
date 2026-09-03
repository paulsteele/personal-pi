import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { posix } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { warmBashParser } from "./access-intent/bash/parser.ts";
import { BashProgram } from "./access-intent/bash/program.ts";
import { classify, type ReviewFacts } from "./auto/classifier.ts";
import {
  type AutoModeSnapshot,
  footerLabel,
  type ModelReviewResult,
  type Verdict,
} from "./auto/core.ts";
import { formatEditForClassifier } from "./auto/edit-preview.ts";
import { createAutoPublisher } from "./auto/events.ts";
import { evaluateSafety, type SafetyContext } from "./auto/safety-policy.ts";
import {
  boundedNotes,
  CLASSIFIER_NOTE_ENTRY,
  type ClassifierNote,
  normalizeNote,
  noteDigest,
  notesFromBranch,
} from "./auto/session-notes.ts";
import { type Config, loadConfig, saveAutoEnabled, saveAutoModel } from "./config.ts";
import { ReviewLogger } from "./logging.ts";
import { PathNormalizer } from "./path-normalizer.ts";
import {
  type EventBus,
  emitDecision,
  emitUiPrompt,
  type PermissionDecisionEvent,
} from "./permission-events.ts";
import { checkPolicy, type PolicyDecision } from "./policy.ts";
import { presentPermissionPrompt } from "./prompt/component.ts";
import {
  appendPermissionOutcome,
  appendPermissionRequest,
  registerPermissionEntryRenderers,
} from "./prompt/entries.ts";
import {
  buildPermissionPromptPayload,
  type PermissionPromptPayload,
  type PermissionReview,
} from "./prompt/payload.ts";

const STATUS_KEY = "auto-mode";
const REVIEW_LOG = "pi-permission-system-permission-review.jsonl";

interface ActiveSkill {
  name: string;
  filePath: string;
  baseDir: string;
}

interface Runtime {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: Config;
  enabled: boolean;
  notes: readonly ClassifierNote[];
  skills: readonly ActiveSkill[];
  gitRemotes: readonly string[];
  cache: Map<string, Verdict>;
  sessionExternalDirectories: Set<string>;
  counts: { allowed: number; asked: number };
  publisher: ReturnType<typeof createAutoPublisher>;
  logger: ReviewLogger;
  events: EventBus;
}

function clean(value: unknown, max = 500): string {
  return typeof value === "string"
    ? Array.from(
        value
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      )
        .slice(0, max)
        .join("")
    : "";
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toolInputPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const direct =
    typeof record.path === "string"
      ? record.path
      : typeof record.file_path === "string"
        ? record.file_path
        : undefined;
  if (direct?.trim()) return direct;
  const args = record.arguments;
  if (args && typeof args === "object") {
    const nested = args as Record<string, unknown>;
    const value =
      typeof nested.path === "string"
        ? nested.path
        : typeof nested.file_path === "string"
          ? nested.file_path
          : undefined;
    return value?.trim() ? value : null;
  }
  return null;
}

function requestId(toolCallId: string): string {
  return `perm-${toolCallId || crypto.randomUUID()}`;
}

function externalDirectoryForPath(value: string, normalizer: PathNormalizer): string | undefined {
  const canonical = normalizer.forPath(value).boundaryValue() || normalizer.comparableValue(value);
  if (!canonical || !posix.isAbsolute(canonical) || canonical === "/") return undefined;
  try {
    return statSync(canonical).isDirectory() ? canonical : posix.dirname(canonical);
  } catch {
    // A missing target may itself be a directory being created. Persisting that
    // exact path is safer than broadening the grant to its existing parent.
    return canonical;
  }
}

function skillNameFromInput(value: string): string | null {
  const match = /^\s*\/skill:([^\s]+)/.exec(value);
  return match?.[1]?.trim() || null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function hideDeniedSkills(systemPrompt: string, permission: Config["permission"]): string {
  return systemPrompt.replace(/<available_skills>([\s\S]*?)<\/available_skills>/g, (section) => {
    const blocks = [...section.matchAll(/\s*<skill>([\s\S]*?)<\/skill>/g)];
    let filtered = section;
    for (const block of blocks) {
      const name = /<name>([\s\S]*?)<\/name>/.exec(block[1])?.[1];
      if (name && checkPolicy(permission, "skill", decodeXml(name.trim())).state === "deny")
        filtered = filtered.replace(block[0], "");
    }
    return /<skill>/.test(filtered) ? filtered : "";
  });
}

function recentUserTurns(ctx: ExtensionContext, limit: number): readonly string[] {
  if (limit <= 0) return [];
  const turns: string[] = [];
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    const record = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (record.type !== "message" || record.message?.role !== "user") continue;
    const content = record.message.content;
    const value =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (part): part is { type: "text"; text: string } =>
                  typeof part === "object" &&
                  part !== null &&
                  (part as { type?: unknown }).type === "text" &&
                  typeof (part as { text?: unknown }).text === "string",
              )
              .map((part) => part.text)
              .join("\n")
          : "";
    if (value.trim()) turns.push(value.trim());
    if (turns.length >= limit) break;
  }
  return turns.reverse();
}

async function refreshGitRemotes(pi: ExtensionAPI, runtime: Runtime): Promise<void> {
  try {
    const result = await pi.exec("git", ["remote", "-v"], { cwd: runtime.ctx.cwd, timeout: 3_000 });
    if (result.code !== 0) return;
    const remotes = new Set<string>();
    for (const line of result.stdout.split("\n")) {
      const match = /^(\S+)\s+(\S+)/.exec(line.trim());
      if (match) remotes.add(`${match[1]} ${match[2]}`);
    }
    runtime.gitRemotes = [...remotes];
  } catch {
    runtime.gitRemotes = [];
  }
}

async function humanDecision(
  runtime: Runtime,
  request: {
    id: string;
    toolCallId: string;
    surface: string;
    value: string;
    pattern: string | null;
    category?: string;
    reason?: string;
    source?: "tool_call" | "skill_input" | "skill_read";
    payload?: PermissionPromptPayload;
    allowDirectory?: string;
  },
): Promise<{ allowed: boolean; reason: string | null }> {
  const { ctx } = runtime;
  if (!ctx.hasUI) return { allowed: false, reason: "No interactive human authority is available." };
  const payload =
    request.payload ??
    buildPermissionPromptPayload({
      surface: request.surface,
      value: request.value,
      matchedPattern: request.pattern,
      category: request.category,
      reason: request.reason,
    });
  const classifierFeedback = payload.review.source === "classifier";
  emitUiPrompt(runtime.events, {
    requestId: request.id,
    toolCallId: request.toolCallId || null,
    source: request.source ?? "tool_call",
    surface: request.surface,
    value: request.value,
  });
  if (ctx.mode === "tui")
    appendPermissionRequest(runtime.pi, request.id, request.toolCallId || null, payload);
  const choice = await presentPermissionPrompt(
    ctx,
    "Permission Required",
    payload,
    classifierFeedback,
    Boolean(request.allowDirectory),
  );
  if (ctx.mode === "tui")
    appendPermissionOutcome(runtime.pi, request.id, request.toolCallId || null, choice);
  if (!choice) return { allowed: false, reason: "Human cancelled permission confirmation." };
  const allow = choice === "approve" || choice === "approve_directory" || choice === "approve_note";
  if (choice === "approve_directory") {
    if (!request.allowDirectory)
      return { allowed: false, reason: "No specific external directory was available to allow." };
    runtime.sessionExternalDirectories.add(request.allowDirectory);
    runtime.cache.clear();
    ctx.ui.notify(`Allowed external directory for this session: ${request.allowDirectory}`, "info");
  }
  const noteChoice = choice === "approve_note" || choice === "deny_note";
  if (noteChoice) {
    const draft = await ctx.ui.input("Classifier note for this session");
    const note = normalizeNote(draft);
    // A note is optional metadata for later classifier calls. Cancelling or
    // blanking it leaves this already-confirmed decision authoritative.
    if (!note)
      return {
        allowed: allow,
        reason: allow ? null : (request.reason ?? "Human denied permission."),
      };
    (
      ctx.sessionManager as unknown as {
        appendCustomEntry(customType: string, data?: unknown): string;
      }
    ).appendCustomEntry(CLASSIFIER_NOTE_ENTRY, { version: 1, text: note.text });
    runtime.notes = boundedNotes([...runtime.notes, note]);
    runtime.cache.clear();
    runtime.logger.review("classifier_note.added", {
      requestId: request.id,
      toolCallId: request.toolCallId || null,
      length: note.text.length,
      digest: note.digest,
    });
  }
  return { allowed: allow, reason: allow ? null : (request.reason ?? "Human denied permission.") };
}

function decision(runtime: Runtime, event: PermissionDecisionEvent): void {
  const value = event.value;
  const reason = event.reason;
  const pattern = event.matchedPattern;
  const source =
    event.decidedBy.kind === "auto"
      ? { kind: "auto", verdict: event.decidedBy.verdict }
      : event.decidedBy.kind === "guard"
        ? { kind: "guard", category: event.decidedBy.category }
        : { kind: event.decidedBy.kind };
  runtime.logger.review("permission.decision", {
    requestId: event.requestId,
    toolCallId: event.toolCallId,
    surface: event.surface,
    result: event.result,
    resolution: event.resolution,
    decidedBy: source,
    category: event.category,
    value: "[redacted]",
    valueLength: Array.from(value).length,
    valueDigest: createHash("sha256").update(value).digest("hex"),
    ...(pattern
      ? {
          matchedPattern: "[redacted]",
          matchedPatternDigest: createHash("sha256").update(pattern).digest("hex"),
        }
      : {}),
    ...(reason
      ? {
          reason: "[redacted]",
          reasonLength: Array.from(reason).length,
          reasonDigest: createHash("sha256").update(reason).digest("hex"),
        }
      : {}),
  });
  emitDecision(runtime.events, event);
}

function snapshot(runtime: Runtime): AutoModeSnapshot {
  return {
    enabled: runtime.enabled,
    usable: Boolean(runtime.config.auto.provider && runtime.config.auto.model),
    modelId: `${runtime.config.auto.provider}/${runtime.config.auto.model}`,
    ...runtime.counts,
  };
}

function publish(runtime: Runtime): void {
  const current = snapshot(runtime);
  if (runtime.ctx.hasUI)
    runtime.ctx.ui.setStatus(STATUS_KEY, runtime.enabled ? footerLabel(current) : undefined);
  runtime.publisher.update(current);
}

function policyForCall(
  config: Config,
  sessionExternalDirectories: ReadonlySet<string>,
  toolName: string,
  command: string | null,
  directPath: string | null,
  skillName: string | null,
  normalizer: PathNormalizer,
  program: BashProgram | null,
): { surface: string; value: string; decision: PolicyDecision } {
  const checks: Array<{ surface: string; value: string; decision: PolicyDecision }> = [];
  const sessionAllows = (surface: string, matchValues: readonly string[]): boolean =>
    surface === "external_directory" &&
    matchValues.some((value) =>
      [...sessionExternalDirectories].some(
        (directory) => value === directory || value.startsWith(`${directory}/`),
      ),
    );
  const add = (surface: string, displayValue: string, matchValues = [displayValue]): void => {
    if ((surface === "path" || surface === "external_directory") && !(surface in config.permission))
      return;
    const decisions = matchValues.map((matchValue) =>
      checkPolicy(config.permission, surface, matchValue),
    );
    // Lexical and canonical aliases describe the same path. Any explicit deny
    // remains strongest; otherwise an allow on either alias covers the access.
    const explicitDeny = decisions.find((candidate) => candidate.state === "deny");
    const decision =
      explicitDeny ??
      (sessionAllows(surface, matchValues)
        ? { state: "allow" as const, matchedPattern: "<session-directory>", reason: null }
        : undefined) ??
      decisions.find((candidate) => candidate.state === "allow") ??
      decisions[0] ??
      checkPolicy(config.permission, surface, displayValue);
    checks.push({ surface, value: displayValue, decision });
  };
  if (skillName) add("skill", skillName);
  if (directPath) {
    const path = normalizer.forPath(directPath);
    add("path", directPath, path.matchValues());
    if (normalizer.isOutsideWorkingDirectory(directPath))
      add("external_directory", directPath, path.matchValues());
  }
  for (const candidate of program?.pathRuleCandidates() ?? [])
    add("path", candidate.path.value(), candidate.path.matchValues());
  for (const external of program?.externalPaths() ?? [])
    add("external_directory", external.value(), external.matchValues());
  if (command) {
    // Gate every executable projection as well as the full source. Compound
    // units are retained by BashProgram, so explicit inner deny/ask rules
    // cannot be hidden by control flow or a permissive whole-command match.
    for (const unit of program?.commands() ?? []) add("bash", unit.text);
    add("bash", command);
  } else {
    add(toolName, toolName);
  }
  const rank = (state: PolicyDecision["state"]): number =>
    state === "deny" ? 2 : state === "ask" ? 1 : 0;
  return checks.reduce((worst, candidate) =>
    rank(candidate.decision.state) > rank(worst.decision.state) ? candidate : worst,
  );
}

function classifyFacts(
  toolName: string,
  input: unknown,
  command: string | null,
  selected: { surface: string; value: string; decision: PolicyDecision },
): ReviewFacts {
  const edit =
    toolName === "edit" && input && typeof input === "object"
      ? formatEditForClassifier(input as Record<string, unknown>)
      : undefined;
  return {
    surface: selected.surface,
    toolName,
    invokedToolName: selected.surface === "skill" ? selected.value : null,
    value: selected.value,
    matchedPattern: selected.decision.matchedPattern,
    commandContext: null,
    executedUnit: null,
    agentName: null,
    evidence: edit
      ? [{ label: "input", text: edit, detail: null }]
      : command
        ? [{ label: "full command", text: command, detail: null }]
        : [],
  };
}

async function modelDecision(
  runtime: Runtime,
  ctx: ExtensionContext,
  requestIdValue: string,
  facts: ReviewFacts,
  riskMarkers: readonly string[],
  toolCallId: string | null,
): Promise<ModelReviewResult> {
  if (ctx.signal?.aborted) return { kind: "cancelled", modelCalled: false };
  const key = createHash("sha256")
    .update(JSON.stringify([facts, noteDigest(runtime.notes)]))
    .digest("hex");
  const cached = runtime.cache.get(key);
  if (cached) return { kind: "allow", modelCalled: false };
  const model = ctx.modelRegistry.find(runtime.config.auto.provider, runtime.config.auto.model);
  const unavailable: ModelReviewResult = !model
    ? {
        kind: "require_human",
        reason:
          "The configured classifier model is unavailable, so it could not approve this action.",
        cause: "model-unavailable",
        modelCalled: false,
      }
    : !ctx.modelRegistry.hasConfiguredAuth(model)
      ? {
          kind: "require_human",
          reason: "Classifier authentication is unavailable, so it could not approve this action.",
          cause: "auth-unavailable",
          modelCalled: false,
        }
      : { kind: "allow", modelCalled: false };
  if (unavailable.kind === "require_human") {
    runtime.publisher.decision(
      {
        requestId: requestIdValue,
        mechanism: "model",
        category: null,
        surface: facts.surface,
        value: facts.value,
        verdict: "require_human",
        reason: unavailable.reason,
        cause: unavailable.cause,
        at: Date.now(),
      },
      toolCallId,
    );
    return unavailable;
  }
  const response = await classify({
    caller: ctx.modelRegistry as never,
    model: model as never,
    facts,
    context: {
      cwd: ctx.cwd,
      gitRemotes: runtime.gitRemotes,
      trustedRoots: runtime.config.auto.environment.trustedRoots,
      trustedRemotes: runtime.config.auto.environment.trustedRemotes,
      trustedDomains: runtime.config.auto.environment.trustedDomains,
      notes: runtime.notes,
      riskMarkers,
      recentUserTurns: recentUserTurns(ctx, runtime.config.auto.contextUserTurns),
    },
    config: runtime.config.auto,
    signal: ctx.signal,
  });
  if (response.kind === "allow") runtime.cache.set(key, { kind: "allow" });
  if (response.kind !== "cancelled")
    runtime.publisher.decision(
      {
        requestId: requestIdValue,
        mechanism: "model",
        category: null,
        surface: facts.surface,
        value: facts.value,
        verdict: response.kind,
        reason: response.kind === "require_human" ? response.reason : null,
        cause: response.kind === "require_human" ? response.cause : null,
        at: Date.now(),
      },
      toolCallId,
    );
  return response;
}

export default function permissionSystem(pi: ExtensionAPI): void {
  registerPermissionEntryRenderers(pi);
  let runtime: Runtime | undefined;

  const reload = (ctx: ExtensionContext): Runtime => {
    runtime?.publisher.dispose();
    const loaded = loadConfig(getAgentDir());
    const next: Runtime = {
      pi,
      ctx,
      config: loaded.config,
      enabled: loaded.config.auto.enabledByDefault,
      notes: notesFromBranch(ctx.sessionManager.getBranch()),
      skills: [],
      gitRemotes: [],
      cache: new Map(),
      sessionExternalDirectories: new Set(),
      counts: { allowed: 0, asked: 0 },
      publisher: createAutoPublisher(pi.events),
      events: pi.events,
      logger: new ReviewLogger(
        `${getAgentDir()}/extensions/pi-permission-system/logs/${REVIEW_LOG}`,
      ),
    };
    for (const issue of loaded.issues) next.logger.review("config.warning", { issue });
    runtime = next;
    publish(next);
    return next;
  };

  pi.on("session_start", async (_event, ctx) => {
    await refreshGitRemotes(pi, reload(ctx));
  });
  pi.on("session_tree", (_event, ctx) => {
    if (runtime) {
      runtime.ctx = ctx;
      runtime.notes = notesFromBranch(ctx.sessionManager.getBranch());
      runtime.cache.clear();
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    await warmBashParser();
    const current = runtime ?? reload(ctx);
    current.skills = (event.systemPromptOptions.skills ?? []).map((skill) => ({
      name: skill.name,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
    }));
    if (current.gitRemotes.length === 0) await refreshGitRemotes(pi, current);
    const systemPrompt = hideDeniedSkills(event.systemPrompt, current.config.permission);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });
  pi.on("turn_start", () => runtime?.cache.clear());
  pi.on("session_shutdown", () => {
    if (runtime?.ctx.hasUI) runtime.ctx.ui.setStatus(STATUS_KEY, undefined);
    runtime?.publisher.dispose();
    runtime = undefined;
  });

  pi.registerCommand("auto", {
    description: "Toggle and persist integrated auto permission review",
    handler: async (args, ctx) => {
      const current = runtime ?? reload(ctx);
      const value = args.trim().toLowerCase();
      const enabled = value === "on" ? true : value === "off" ? false : !current.enabled;
      saveAutoEnabled(getAgentDir(), enabled);
      current.enabled = enabled;
      current.config = {
        ...current.config,
        auto: { ...current.config.auto, enabledByDefault: enabled },
      };
      current.cache.clear();
      publish(current);
    },
  });
  pi.registerShortcut("ctrl+shift+a", {
    description: "Toggle auto permission review",
    handler: async (ctx) => {
      const current = runtime ?? reload(ctx as ExtensionContext);
      const enabled = !current.enabled;
      saveAutoEnabled(getAgentDir(), enabled);
      current.enabled = enabled;
      current.config = {
        ...current.config,
        auto: { ...current.config.auto, enabledByDefault: enabled },
      };
      current.cache.clear();
      publish(current);
    },
  });
  pi.registerCommand("auto-model", {
    description: "Select and persist the integrated auto classifier model",
    handler: async (args, ctx) => {
      const current = runtime ?? reload(ctx);
      const requested = args.trim();
      const available = ctx.modelRegistry.getAvailable();
      const selected = requested
        ? available.find((model) => `${model.provider}/${model.id}` === requested)
        : ctx.hasUI
          ? await (async () => {
              const choice = await ctx.ui.select(
                "Auto classifier",
                available.map((m) => `${m.provider}/${m.id}`),
              );
              return available.find((m) => `${m.provider}/${m.id}` === choice);
            })()
          : undefined;
      if (!selected) return;
      saveAutoModel(getAgentDir(), selected.provider, selected.id);
      current.config = {
        ...current.config,
        auto: { ...current.config.auto, provider: selected.provider, model: selected.id },
      };
      current.cache.clear();
      publish(current);
    },
  });

  pi.on("input", async (event, ctx) => {
    const current = runtime ?? reload(ctx);
    const skillName = skillNameFromInput(event.text);
    if (!skillName) return { action: "continue" as const };
    const policy = checkPolicy(current.config.permission, "skill", skillName);
    const req = requestId("");
    if (policy.state === "deny") {
      decision(current, {
        requestId: req,
        toolCallId: null,
        surface: "skill",
        value: skillName,
        result: "deny",
        resolution: "policy_deny",
        decidedBy: { kind: "policy", pattern: policy.matchedPattern },
        matchedPattern: policy.matchedPattern,
        reason: policy.reason,
      });
      if (ctx.hasUI) ctx.ui.notify(`Skill '${skillName}' is not permitted.`, "warning");
      return { action: "handled" as const };
    }
    if (policy.state === "allow") {
      decision(current, {
        requestId: req,
        toolCallId: null,
        surface: "skill",
        value: skillName,
        result: "allow",
        resolution: "policy_allow",
        decidedBy: { kind: "policy", pattern: policy.matchedPattern },
        matchedPattern: policy.matchedPattern,
      });
      return { action: "continue" as const };
    }
    let review: PermissionReview = { source: "policy", reason: policy.reason };
    if (current.enabled) {
      const verdict = await modelDecision(
        current,
        ctx,
        req,
        {
          surface: "skill",
          toolName: null,
          invokedToolName: skillName,
          value: skillName,
          matchedPattern: policy.matchedPattern,
          commandContext: null,
          executedUnit: null,
          agentName: null,
          evidence: [],
        },
        [],
        null,
      );
      if (verdict.kind === "cancelled") return { action: "handled" as const };
      if (verdict.kind === "allow") {
        current.counts.allowed += 1;
        publish(current);
        decision(current, {
          requestId: req,
          toolCallId: null,
          surface: "skill",
          value: skillName,
          result: "allow",
          resolution: "auto_approved",
          decidedBy: { kind: "auto", verdict: "allow" },
        });
        return { action: "continue" as const };
      }
      current.counts.asked += 1;
      publish(current);
      review = { source: "classifier", reason: verdict.reason, cause: verdict.cause };
    }
    const human = await humanDecision(current, {
      id: req,
      toolCallId: "",
      surface: "skill",
      value: skillName,
      pattern: policy.matchedPattern,
      source: "skill_input",
      payload: buildPermissionPromptPayload({
        surface: "skill",
        value: skillName,
        matchedPattern: policy.matchedPattern,
        reason: policy.reason ?? undefined,
        review,
      }),
    });
    decision(current, {
      requestId: req,
      toolCallId: null,
      surface: "skill",
      value: skillName,
      result: human.allowed ? "allow" : "deny",
      resolution: human.allowed ? "user_approved" : "user_denied",
      decidedBy: { kind: "human" },
      matchedPattern: policy.matchedPattern,
      reason: human.reason,
    });
    return { action: human.allowed ? ("continue" as const) : ("handled" as const) };
  });

  pi.on("tool_call", async (event, ctx) => {
    const current = runtime ?? reload(ctx);
    const raw = event as {
      toolName?: unknown;
      name?: unknown;
      toolCallId?: unknown;
      input?: unknown;
      arguments?: unknown;
    };
    const toolName = clean(raw.toolName ?? raw.name, 100) || "unknown";
    const toolCallId = clean(raw.toolCallId, 160);
    const input = raw.input ?? raw.arguments ?? {};
    const normalizer = new PathNormalizer(ctx.cwd);
    const command =
      toolName === "bash" && input && typeof input === "object"
        ? text((input as Record<string, unknown>).command)
        : null;
    const program = command ? await BashProgram.parse(command, normalizer) : null;
    const directPath = toolInputPath(input);
    const normalizedDirectPath = directPath
      ? normalizer.forPath(directPath).boundaryValue() || normalizer.comparableValue(directPath)
      : "";
    const matchedSkill =
      toolName === "read"
        ? current.skills
            .filter((skill) => {
              const filePath =
                normalizer.forPath(skill.filePath).boundaryValue() ||
                normalizer.comparableValue(skill.filePath);
              const baseDir =
                normalizer.forPath(skill.baseDir).boundaryValue() ||
                normalizer.comparableValue(skill.baseDir);
              return (
                normalizedDirectPath === filePath ||
                normalizer.isWithinDirectory(normalizedDirectPath, baseDir)
              );
            })
            .sort((left, right) => right.baseDir.length - left.baseDir.length)[0]
        : undefined;
    const paths = [
      ...(directPath ? [normalizer.forPath(directPath)] : []),
      ...(program?.pathRuleCandidates().map((entry) => entry.path) ?? []),
      ...(program?.externalPaths() ?? []),
    ];
    const guardContext: SafetyContext = {
      requestId: requestId(toolCallId),
      toolCallId,
      toolName,
      agentName: null,
      input,
      cwd: ctx.cwd,
      platform: process.platform,
      shell: command
        ? {
            command,
            workdir: null,
            parseComplete: program?.isParseComplete() ?? false,
            unresolvedPathExpression: program?.hasUnresolvedPathExpression() ?? false,
            commands: (program?.guardCommands() ?? []).map((unit) => ({
              text: unit.text,
              argv: unit.argv ?? null,
              context: unit.context ?? null,
              wrapperKind: unit.wrapperKind ?? null,
              executedUnit: unit.executedUnit ?? null,
            })),
          }
        : null,
      paths: paths.map((path) => ({
        value: path.value(),
        matchValues: path.matchValues(),
        boundaryValue: path.boundaryValue() || null,
        mountAliases: [],
        mountResolutionIncomplete: false,
      })),
      riskMarkers: program && !program.isParseComplete() ? ["shell-parse-incomplete"] : [],
    };
    const safety = evaluateSafety(guardContext, current.enabled, { home: process.env.HOME ?? "" });
    const req = guardContext.requestId;
    // The safety stage is evaluated first to collect deterministic risk evidence.
    // A persistent deny remains stronger and is resolved before every escalation.
    const selected = policyForCall(
      current.config,
      current.sessionExternalDirectories,
      toolName,
      command,
      directPath,
      matchedSkill?.name ?? null,
      normalizer,
      program,
    );
    const policyValue = selected.value;
    const policy = selected.decision;
    const allowDirectory =
      selected.surface === "external_directory"
        ? externalDirectoryForPath(selected.value, normalizer)
        : undefined;
    const promptSource = matchedSkill ? "skill_read" : "tool_call";
    const promptPayload = (
      category?: string,
      reason?: string,
      review?: PermissionReview,
    ): PermissionPromptPayload =>
      buildPermissionPromptPayload({
        surface: selected.surface,
        value: policyValue,
        matchedPattern: policy.matchedPattern,
        category,
        reason,
        review,
        toolName,
        command,
        cwd: ctx.cwd,
        commandUnits: program?.guardCommands().map((unit) => ({
          ...unit,
          // Presentation only: show units covered by deterministic Bash policy
          // in the policy color, without changing aggregate policy selection or
          // any classifier facts/verdict behavior.
          policyState: checkPolicy(current.config.permission, "bash", unit.text).state,
        })),
        paths: paths.map((path) => ({
          value: path.value(),
          resolved: path.resolvedAlias(),
        })),
        inputPreview:
          toolName === "edit" && input && typeof input === "object"
            ? formatEditForClassifier(input as Record<string, unknown>)
            : undefined,
      });
    // Persistent policy deny is stronger than a deterministic escalation.
    if (policy.state === "deny") {
      decision(current, {
        requestId: req,
        toolCallId: toolCallId || null,
        surface: selected.surface,
        value: policyValue,
        result: "deny",
        resolution: "policy_deny",
        decidedBy: { kind: "policy", pattern: policy.matchedPattern },
        matchedPattern: policy.matchedPattern,
        reason: policy.reason,
      });
      return { block: true, reason: "Denied by permission policy." };
    }
    if (safety.kind === "require_human") {
      current.publisher.decision(
        {
          requestId: req,
          mechanism: "guard",
          category: safety.category,
          surface: toolName,
          value: policyValue,
          verdict: "require_human",
          reason: safety.reason,
          cause: null,
          at: Date.now(),
        },
        toolCallId || null,
      );
      const human = await humanDecision(current, {
        id: req,
        toolCallId,
        surface: toolName,
        value: policyValue,
        pattern: `<guard:${safety.category}>`,
        category: safety.category,
        reason: safety.reason,
        source: promptSource,
        payload: promptPayload(safety.category, safety.reason, {
          source: "guard",
          reason: safety.reason,
          category: safety.category,
        }),
      });
      decision(current, {
        requestId: req,
        toolCallId: toolCallId || null,
        surface: toolName,
        value: policyValue,
        result: human.allowed ? "allow" : "deny",
        resolution: human.allowed ? "user_approved" : "user_denied",
        decidedBy: { kind: "human" },
        category: safety.category,
        reason: human.reason,
      });
      return human.allowed ? {} : { block: true, reason: human.reason ?? safety.reason };
    }
    const unresolvedPathExpression = safety.riskMarkers.includes("unresolved-path-expression");
    if (policy.state === "allow" && !unresolvedPathExpression) {
      decision(current, {
        requestId: req,
        toolCallId: toolCallId || null,
        surface: selected.surface,
        value: policyValue,
        result: "allow",
        resolution: "policy_allow",
        decidedBy: { kind: "policy", pattern: policy.matchedPattern },
        matchedPattern: policy.matchedPattern,
      });
      return {};
    }
    let review: PermissionReview = {
      source: "policy",
      reason: unresolvedPathExpression
        ? "A filesystem path contains a shell expansion that could not be resolved statically."
        : policy.reason,
    };
    if (current.enabled) {
      const facts = classifyFacts(toolName, input, command, selected);
      const verdict = await modelDecision(
        current,
        ctx,
        req,
        facts,
        safety.riskMarkers,
        toolCallId || null,
      );
      if (verdict.kind === "cancelled")
        return { block: true, reason: "Permission review cancelled." };
      if (verdict.kind === "allow") {
        current.counts.allowed += 1;
        publish(current);
        decision(current, {
          requestId: req,
          toolCallId: toolCallId || null,
          surface: facts.surface,
          value: facts.value,
          result: "allow",
          resolution: "auto_approved",
          decidedBy: { kind: "auto", verdict: "allow" },
        });
        return {};
      }
      current.counts.asked += 1;
      publish(current);
      review = { source: "classifier", reason: verdict.reason, cause: verdict.cause };
    }
    const human = await humanDecision(current, {
      id: req,
      toolCallId,
      surface: selected.surface,
      value: policyValue,
      pattern: policy.matchedPattern,
      source: promptSource,
      ...(allowDirectory ? { allowDirectory } : {}),
      payload: promptPayload(
        undefined,
        unresolvedPathExpression
          ? "A filesystem path contains a shell expansion that could not be resolved statically."
          : (policy.reason ?? undefined),
        review,
      ),
    });
    decision(current, {
      requestId: req,
      toolCallId: toolCallId || null,
      surface: selected.surface,
      value: policyValue,
      result: human.allowed ? "allow" : "deny",
      resolution: human.allowed ? "user_approved" : "user_denied",
      decidedBy: { kind: "human" },
      reason: human.reason,
    });
    return human.allowed ? {} : { block: true, reason: human.reason ?? "Human denied permission." };
  });
}
