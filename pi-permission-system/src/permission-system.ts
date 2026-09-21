import { createHash } from "node:crypto";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { warmBashParser } from "./access-intent/bash/parser.ts";
import { classify, type ReviewFacts } from "./auto/classifier.ts";
import {
  type AutoModeSnapshot,
  footerLabel,
  type ModelReviewResult,
  type Verdict,
} from "./auto/core.ts";
import { createAutoPublisher } from "./auto/events.ts";
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
import { ApprovalQueue } from "./approval-queue.ts";
import {
  createDelegatedReviewService,
  permissionRevision,
  REVIEW_SERVICE_CHANNEL,
  type DelegatedActor,
} from "./delegated-review.ts";
import {
  type EventBus,
  emitDecision,
  emitUiPrompt,
  type PermissionDecisionEvent,
  PERMISSIONS_REVIEW_STATE_CHANNEL,
} from "./permission-events.ts";
import { checkPolicy } from "./policy.ts";
import {
  reviewToolCall,
  reviewRevision,
  type ActiveSkill,
  type ReviewState,
  type ToolReviewRequest,
  type HumanReviewRequest,
} from "./tool-review.ts";
import { ALLOW_SESSION_FILES_CHANNEL, sessionFileGrants } from "./session-files.ts";
import { presentPermissionPrompt } from "./prompt/component.ts";
import {
  appendPermissionOutcome,
  appendPermissionRequest,
  registerPermissionEntryRenderers,
} from "./prompt/entries.ts";

const STATUS_KEY = "auto-mode";
const REVIEW_LOG = "pi-permission-system-permission-review.jsonl";

interface Runtime {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: Config;
  revision: string;
  agentDir: string;
  lifetime: AbortController;
  approvals: ApprovalQueue;
  delegated?: ReturnType<typeof createDelegatedReviewService>;
  enabled: boolean;
  notes: readonly ClassifierNote[];
  skills: readonly ActiveSkill[];
  gitRemotes: readonly string[];
  cache: Map<string, Verdict>;
  sessionExternalDirectories: Set<string>;
  sessionExternalFiles: Set<string>;
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
  request: HumanReviewRequest,
): Promise<{
  allowed: boolean;
  reason: string | null;
  stale?: boolean;
  unavailable?: boolean;
}> {
  const { ctx } = runtime;
  if (!ctx.hasUI)
    return {
      allowed: false,
      reason: "No interactive human authority is available.",
      unavailable: true,
    };
  const announce = (state: "queued" | "showing" | "finished") => {
    try {
      runtime.events.emit(PERMISSIONS_REVIEW_STATE_CHANNEL, {
        requestId: request.id,
        toolCallId: request.toolCallId || null,
        delegated: request.delegated,
        state,
      });
    } catch {
      /* presentation is non-authoritative */
    }
  };
  const isCurrent = () => {
    try {
      return request.isCurrent();
    } catch {
      return false;
    }
  };
  announce("queued");
  try {
    return await runtime.approvals.run(request.signal, async (signal) => {
      if (!isCurrent())
        return { allowed: false, reason: "Permission context changed.", stale: true };
      announce("showing");
      emitUiPrompt(runtime.events, {
        requestId: request.id,
        toolCallId: request.toolCallId || null,
        delegated: request.delegated,
        source: request.source,
        surface: request.surface,
        value: request.value,
      });
      if (ctx.mode === "tui")
        appendPermissionRequest(
          runtime.pi,
          request.id,
          request.toolCallId || null,
          request.payload,
        );
      const choice = await presentPermissionPrompt(
        ctx,
        "Permission Required",
        request.payload,
        request.payload.review.source === "classifier",
        Boolean(request.allowDirectory),
        signal,
      );
      let stale = !signal.aborted && !isCurrent();
      const allow =
        choice === "approve" || choice === "approve_directory" || choice === "approve_note";
      if (!stale && !signal.aborted && (choice === "approve_note" || choice === "deny_note")) {
        const draft = await ctx.ui.input("Classifier note for this session", undefined, { signal });
        const note = normalizeNote(draft);
        stale = !signal.aborted && !isCurrent();
        if (!stale && !signal.aborted && note) {
          (
            ctx.sessionManager as unknown as {
              appendCustomEntry(type: string, data: unknown): string;
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
      }
      if (ctx.mode === "tui" && !runtime.lifetime.signal.aborted)
        appendPermissionOutcome(
          runtime.pi,
          request.id,
          request.toolCallId || null,
          choice,
          signal.aborted ? "cancelled" : stale ? "superseded" : undefined,
        );
      if (stale) return { allowed: false, reason: "Permission context changed.", stale: true };
      if (signal.aborted || !choice)
        return { allowed: false, reason: "Human cancelled permission confirmation." };
      if (choice === "approve_directory") {
        if (!request.allowDirectory)
          return {
            allowed: false,
            reason: "No specific external directory was available to allow.",
          };
        runtime.sessionExternalDirectories.add(request.allowDirectory);
        runtime.cache.clear();
        ctx.ui.notify(
          `Allowed external directory for this session: ${request.allowDirectory}`,
          "info",
        );
      }
      return {
        allowed: allow,
        reason: allow ? null : (request.reason ?? "Human denied permission."),
      };
    });
  } finally {
    announce("finished");
  }
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

function refreshPolicy(runtime: Runtime): ReviewState {
  const loaded = loadConfig(runtime.agentDir);
  if (loaded.issues.length) {
    runtime.cache.clear();
    throw new Error("Permission config is missing, invalid or unreadable.");
  }
  // JSON preserves rule insertion order, which is semantically significant.
  const revision = permissionRevision([loaded.config]);
  if (revision !== runtime.revision) {
    runtime.config = loaded.config;
    runtime.revision = revision;
    runtime.enabled = loaded.config.auto.enabledByDefault;
    runtime.cache.clear();
    publish(runtime);
  }
  return {
    config: runtime.config,
    revision,
    contextRevision: permissionRevision([noteDigest(runtime.notes), runtime.gitRemotes]),
    skills: runtime.skills,
    directories: runtime.sessionExternalDirectories,
    files: runtime.sessionExternalFiles,
  };
}

function authorize(
  runtime: Runtime,
  ctx: ExtensionContext,
  request: ToolReviewRequest,
  actor?: DelegatedActor,
) {
  request = {
    ...request,
    signal: request.signal
      ? AbortSignal.any([runtime.lifetime.signal, request.signal])
      : runtime.lifetime.signal,
  };
  return reviewToolCall(request, {
    refresh: () => {
      runtime.lifetime.signal.throwIfAborted();
      const state = refreshPolicy(runtime);
      return actor
        ? {
            ...state,
            skills: actor.skills ?? state.skills,
            directories: new Set<string>(),
            files: new Set<string>(),
          }
        : state;
    },
    model: (action, state, id, facts, risks) =>
      modelDecision(runtime, ctx, id, facts, risks, action.toolCallId || null, {
        request: action,
        state,
        actor,
      }),
    human: (human) =>
      humanDecision(runtime, {
        ...human,
        ...(actor
          ? {
              delegated: {
                operationId: actor.operationId,
                taskId: actor.taskId,
                taskName: request.agentName ?? "Worker",
                childToolCallId: actor.childToolCallId,
              },
            }
          : {}),
      }),
    decision: (event) => {
      if (!runtime.lifetime.signal.aborted)
        decision(runtime, {
          ...event,
          ...(actor
            ? {
                delegated: {
                  operationId: actor.operationId,
                  taskId: actor.taskId,
                  taskName: request.agentName ?? "Worker",
                  childToolCallId: actor.childToolCallId,
                },
              }
            : {}),
        });
    },
    review: (event, id) => {
      if (!runtime.lifetime.signal.aborted) runtime.publisher.decision(event, id);
    },
    count: (kind) => {
      runtime.counts[kind]++;
      publish(runtime);
    },
  });
}

function createDelegation(runtime: Runtime) {
  return createDelegatedReviewService({
    sessionId: () => runtime.ctx.sessionManager.getSessionId(),
    revision: () => {
      runtime.lifetime.signal.throwIfAborted();
      return reviewRevision(refreshPolicy(runtime));
    },
    authority: () =>
      recentUserTurns(runtime.ctx, refreshPolicy(runtime).config.auto.contextUserTurns),
    authorize: (request, actor) => authorize(runtime, runtime.ctx, request, actor),
  });
}

async function modelDecision(
  runtime: Runtime,
  ctx: ExtensionContext,
  requestIdValue: string,
  facts: ReviewFacts,
  riskMarkers: readonly string[],
  toolCallId: string | null,
  options?: { request: ToolReviewRequest; state: ReviewState; actor?: DelegatedActor },
): Promise<ModelReviewResult> {
  const signal = options?.request.signal ?? ctx.signal;
  const config = options?.state.config ?? runtime.config;
  const cwd = options?.request.cwd ?? ctx.cwd;
  const authority = options?.actor?.authority ?? recentUserTurns(ctx, config.auto.contextUserTurns);
  const cache = options?.actor?.cache ?? runtime.cache;
  if (signal?.aborted) return { kind: "cancelled", modelCalled: false };
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        facts,
        options?.actor?.identity,
        options?.request.input,
        options?.request.effects,
        cwd,
        authority,
        runtime.gitRemotes,
        riskMarkers,
        config,
        noteDigest(runtime.notes),
      ]),
    )
    .digest("hex");
  const cached = cache.get(key);
  if (cached) return { kind: "allow", modelCalled: false };
  const model = ctx.modelRegistry.find(config.auto.provider, config.auto.model);
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
      cwd,
      gitRemotes: runtime.gitRemotes,
      trustedRoots: config.auto.environment.trustedRoots,
      trustedRemotes: config.auto.environment.trustedRemotes,
      trustedDomains: config.auto.environment.trustedDomains,
      notes: runtime.notes,
      riskMarkers,
      recentUserTurns: authority,
    },
    config: config.auto,
    signal,
  });
  if (response.kind === "allow") cache.set(key, { kind: "allow" });
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
  let unsubscribeSessionFiles: (() => void) | undefined;
  let unsubscribeService: (() => void) | undefined;

  const reload = (ctx: ExtensionContext): Runtime => {
    runtime?.approvals.dispose();
    runtime?.lifetime.abort();
    runtime?.delegated?.dispose();
    unsubscribeService?.();
    runtime?.publisher.dispose();
    unsubscribeSessionFiles?.();
    const loaded = loadConfig(getAgentDir());
    const next: Runtime = {
      pi,
      ctx,
      config: loaded.config,
      revision: permissionRevision([loaded.config]),
      agentDir: getAgentDir(),
      lifetime: new AbortController(),
      approvals: new ApprovalQueue(),
      enabled: loaded.config.auto.enabledByDefault,
      notes: notesFromBranch(ctx.sessionManager.getBranch()),
      skills: [],
      gitRemotes: [],
      cache: new Map(),
      sessionExternalDirectories: new Set(),
      sessionExternalFiles: new Set(),
      counts: { allowed: 0, asked: 0 },
      publisher: createAutoPublisher(pi.events),
      events: pi.events,
      logger: new ReviewLogger(
        `${getAgentDir()}/extensions/pi-permission-system/logs/${REVIEW_LOG}`,
      ),
    };
    for (const issue of loaded.issues) next.logger.review("config.warning", { issue });
    runtime = next;
    next.delegated = createDelegation(next);
    unsubscribeService = pi.events.on(REVIEW_SERVICE_CHANNEL, (data) => {
      if (!next.delegated || !data || typeof data !== "object") return;
      const request = data as { version?: unknown; accept?: unknown };
      if (request.version === 1 && typeof request.accept === "function")
        request.accept(next.delegated.service);
    });
    unsubscribeSessionFiles = pi.events.on(ALLOW_SESSION_FILES_CHANNEL, (data) => {
      if (runtime !== next) return;
      const files = sessionFileGrants(data, next.ctx.sessionManager.getSessionId());
      for (const file of files) next.sessionExternalFiles.add(file);
      if (files.length) next.cache.clear();
    });
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
      runtime.delegated?.dispose();
      runtime.delegated = createDelegation(runtime);
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    await warmBashParser();
    const current = runtime ?? reload(ctx);
    if (!loadConfig(current.agentDir).issues.length) refreshPolicy(current);
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
    runtime?.approvals.dispose();
    runtime?.lifetime.abort();
    runtime?.delegated?.dispose();
    unsubscribeService?.();
    unsubscribeService = undefined;
    if (runtime?.ctx.hasUI) runtime.ctx.ui.setStatus(STATUS_KEY, undefined);
    runtime?.publisher.dispose();
    unsubscribeSessionFiles?.();
    unsubscribeSessionFiles = undefined;
    runtime = undefined;
  });

  pi.registerCommand("auto", {
    description: "Toggle and persist integrated auto permission review",
    handler: async (args, ctx) => {
      const current = runtime ?? reload(ctx);
      if (!loadConfig(current.agentDir).issues.length) refreshPolicy(current);
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
      if (!loadConfig(current.agentDir).issues.length) refreshPolicy(current);
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
      if (!loadConfig(current.agentDir).issues.length) refreshPolicy(current);
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
    const skill = skillNameFromInput(event.text);
    if (!skill) return { action: "continue" as const };
    const result = await authorize(runtime ?? reload(ctx), ctx, {
      toolName: "skill",
      input: {},
      skillInput: skill,
      cwd: ctx.cwd,
      toolCallId: "",
      signal: ctx.signal,
    });
    if (result.kind !== "allowed" && ctx.hasUI)
      ctx.ui.notify(`Skill '${skill}' is not permitted.`, "warning");
    return { action: result.kind === "allowed" ? ("continue" as const) : ("handled" as const) };
  });

  pi.on("tool_call", async (event, ctx) => {
    const raw = event as {
      toolName?: unknown;
      name?: unknown;
      toolCallId?: unknown;
      input?: unknown;
      arguments?: unknown;
    };
    const result = await authorize(runtime ?? reload(ctx), ctx, {
      toolName: clean(raw.toolName ?? raw.name, 100) || "unknown",
      input: raw.input ?? raw.arguments ?? {},
      toolCallId: clean(raw.toolCallId, 160),
      cwd: ctx.cwd,
      signal: ctx.signal,
    });
    return result.kind === "allowed" ? {} : { block: true, reason: result.reason };
  });
}
