import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Verdict } from "./auto/core.ts";
import type {
  ActiveSkill,
  ReadEffect,
  ToolReviewRequest,
  ToolReviewResult,
} from "./tool-review.ts";

/** Trusted in-process protocol. No public/model tool or cross-process endpoint. */
export const REVIEW_SERVICE_CHANNEL = "permissions:review-service:v1";

export interface DelegatedAction {
  toolName: string;
  input: unknown;
  effects?: readonly ReadEffect[];
  description?: string;
  callId?: string;
  signal?: AbortSignal;
}
export interface DelegatedTaskSpec {
  id: string;
  name: string;
  assignment: string;
  model: string;
  tools: readonly string[];
  /** Host preparation has no agent turn and never retains classifier verdicts. */
  kind: "worker" | "host";
  signal?: AbortSignal;
}
export interface DelegatedTask {
  readonly maxSourcesPerBatch: number;
  check(action: DelegatedAction): Promise<ToolReviewResult>;
  checkLocalSearch(action: DelegatedAction): Promise<ToolReviewResult>;
  revision(): string;
  nextTurn(): void;
  endTurn(): void;
  close(): Promise<void>;
}
export interface DelegatedOperation {
  task(spec: DelegatedTaskSpec): DelegatedTask;
  close(): Promise<void>;
}
export interface OpenDelegatedOperation {
  sessionId: string;
  id: string;
  cwd: string;
  /** Only the real user command handler may set command. Tool launches use scope. */
  command?: string;
  scope: string;
  parentToolCallId?: string;
  /** Already discovered host metadata; never a request to load child extensions/skills. */
  skills?: readonly ActiveSkill[];
  signal: AbortSignal;
}
export interface DelegatedReviewService {
  version: 1;
  open(options: OpenDelegatedOperation): DelegatedOperation;
}
export interface DelegatedActor {
  cache: Map<string, Verdict>;
  authority: readonly string[];
  identity: string;
  operationId: string;
  taskId: string;
  childToolCallId: string;
  skills?: readonly ActiveSkill[];
}

// These are capabilities, not policy allows. All actual calls still enter the gate.
const READ_ONLY_TOOLS = new Set([
  "read",
  "list_changes",
  "read_source_page",
  "read_before",
  "read_change",
  "list_source",
  "search_source",
  "read_task_input",
  "record_checkpoint",
  "coverage_state",
  "checkpoint_notes",
  "report_blocker",
  "submit_result",
  "read_candidate",
  "record_groups",
  "group_state",
]);
function label(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0")
  );
}
function signal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal;
}

const MAX_SOURCES_PER_BATCH = 32;

export function createDelegatedReviewService(host: {
  sessionId(): string;
  /** Refreshes strict live policy. Throws when the owner/config is unavailable. */
  revision(): string;
  authority(): readonly string[];
  maxSourcesPerBatch?: number;
  openTask?(
    spec: DelegatedTaskSpec,
    operation: OpenDelegatedOperation,
  ):
    | {
        readonly maxSourcesPerBatch?: number;
        authorize(request: ToolReviewRequest): Promise<ToolReviewResult>;
        close(): Promise<void>;
      }
    | undefined;
  cleanupError?(error: unknown): void;
  authorize(request: ToolReviewRequest, actor: DelegatedActor): Promise<ToolReviewResult>;
}) {
  const lifetime = new AbortController();
  const operations = new Map<string, () => Promise<void>>();
  const service: DelegatedReviewService = {
    version: 1,
    open(options) {
      options = {
        ...options,
        ...(options?.skills ? { skills: structuredClone(options.skills) } : {}),
      };
      if (
        lifetime.signal.aborted ||
        !options ||
        options.sessionId !== host.sessionId() ||
        !label(options.id, 160) ||
        operations.has(options.id) ||
        !label(options.cwd, 4096) ||
        !posix.isAbsolute(options.cwd) ||
        !label(options.scope, 4000) ||
        !signal(options.signal) ||
        (options.command !== undefined &&
          (!label(options.command, 4000) || !/^\/pr(?:\s|$)/.test(options.command))) ||
        (options.parentToolCallId !== undefined && !label(options.parentToolCallId, 160)) ||
        (options.skills !== undefined &&
          (!Array.isArray(options.skills) ||
            options.skills.some(
              (skill) =>
                !skill ||
                !label(skill.name, 500) ||
                !label(skill.filePath, 4096) ||
                !label(skill.baseDir, 4096),
            )))
      ) {
        throw new Error("Invalid or retired delegated permission operation");
      }
      host.revision();
      const ownerSession = options.sessionId;
      const authority = [
        ...host.authority(),
        ...(options.command ? [`User invoked ${options.command}`] : []),
      ];
      const controller = new AbortController();
      const combined = AbortSignal.any([lifetime.signal, options.signal, controller.signal]);
      const tasks = new Map<string, () => Promise<void>>();
      let operationClosePromise: Promise<void> | undefined;
      const close = () => {
        operationClosePromise ??= (async () => {
          controller.abort();
          try {
            await Promise.all([...tasks.values()].map((dispose) => dispose()));
          } finally {
            tasks.clear();
            operations.delete(options.id);
          }
        })();
        return operationClosePromise;
      };
      operations.set(options.id, close);
      const assertActive = () => {
        combined.throwIfAborted();
        if (host.sessionId() !== ownerSession) throw new Error("Permission owner session changed");
      };
      return {
        close,
        task(spec) {
          spec = { ...spec, tools: [...(spec?.tools ?? [])] };
          assertActive();
          if (
            !spec ||
            !label(spec.id, 160) ||
            tasks.has(spec.id) ||
            !label(spec.name, 200) ||
            !label(spec.assignment, 16000) ||
            !label(spec.model, 500) ||
            !["worker", "host"].includes(spec.kind) ||
            !Array.isArray(spec.tools) ||
            spec.tools.some((name) => !READ_ONLY_TOOLS.has(name)) ||
            (spec.signal !== undefined && !signal(spec.signal))
          ) {
            throw new Error("Invalid or unsupported delegated task capabilities");
          }
          const permitted = new Set(spec.tools);
          const cache = new Map<string, Verdict>();
          const taskController = new AbortController();
          const taskSignal = AbortSignal.any([
            combined,
            taskController.signal,
            ...(spec.signal ? [spec.signal] : []),
          ]);
          let revision = "",
            sequence = 0,
            turn = 0,
            inTurn = false;
          const resource = host.openTask?.({ ...spec, signal: taskSignal }, options);
          let taskClosePromise: Promise<void> | undefined;
          const closeTask = () => {
            taskClosePromise ??= (async () => {
              taskController.abort();
              cache.clear();
              try {
                await resource?.close();
              } finally {
                tasks.delete(spec.id);
              }
            })();
            return taskClosePromise;
          };
          tasks.set(spec.id, closeTask);
          const currentRevision = () => {
            assertActive();
            taskSignal.throwIfAborted();
            let next: string;
            try {
              next = host.revision();
            } catch (error) {
              cache.clear();
              revision = "";
              throw error;
            }
            if (next !== revision) {
              cache.clear();
              revision = next;
            }
            return next;
          };
          const check = async (
            action: DelegatedAction,
            mode: "disclosure" | "local-search",
          ): Promise<ToolReviewResult> => {
            try {
              currentRevision();
              const isPermittedLocalSearch =
                action?.toolName === "read" && permitted.has("search_source");
              if (
                !action ||
                !permitted.has(action.toolName) ||
                (mode === "local-search" && !isPermittedLocalSearch) ||
                (action.description !== undefined && !label(action.description, 4000)) ||
                (action.callId !== undefined && !label(action.callId, 160)) ||
                (action.signal !== undefined && !signal(action.signal)) ||
                (action.effects !== undefined &&
                  (!Array.isArray(action.effects) ||
                    action.effects.length > MAX_SOURCES_PER_BATCH ||
                    action.effects.some(
                      (effect) =>
                        !effect ||
                        !label(effect.path, 4096) ||
                        !posix.isAbsolute(effect.path) ||
                        (effect.side !== undefined &&
                          effect.side !== "old" &&
                          effect.side !== "new") ||
                        (effect.version !== undefined && !label(effect.version, 1000)) ||
                        (effect.range !== undefined && !label(effect.range, 1000)),
                    )))
              ) {
                return {
                  kind: "denied",
                  reason: "Task capability or permission request is invalid.",
                };
              }
              const callSignal = action.signal
                ? AbortSignal.any([taskSignal, action.signal])
                : taskSignal;
              const actor: DelegatedActor = {
                cache: spec.kind === "worker" && inTurn ? cache : new Map(),
                authority,
                identity: JSON.stringify([options.id, spec.id, turn, spec.model, spec.assignment]),
                operationId: options.id,
                taskId: spec.id,
                childToolCallId: action.callId ?? `source-${++sequence}`,
                ...(options.skills ? { skills: options.skills } : {}),
              };
              const request: ToolReviewRequest = {
                toolName: action.toolName,
                input: structuredClone(action.input),
                cwd: options.cwd,
                toolCallId: options.parentToolCallId ?? "",
                signal: callSignal,
                agentName: spec.name,
                description: `Review scope: ${options.scope}\nDelegated assignment (not user authority): ${spec.assignment}\nRecipient: ${spec.model}\nAction: ${action.description ?? action.toolName}`,
                effects: action.effects ? structuredClone(action.effects) : undefined,
                ...(mode === "local-search" ? { localSearch: true as const } : {}),
              };
              for (;;) {
                const result = await (resource
                  ? resource.authorize(request)
                  : host.authorize(request, actor));
                callSignal.throwIfAborted();
                if (result.kind !== "allowed") return result;
                // Never stamp an old verdict with a newer policy's revision.
                if (result.revision === currentRevision()) return result;
              }
            } catch {
              return taskSignal.aborted || action?.signal?.aborted
                ? { kind: "cancelled", reason: "Delegated permission request cancelled." }
                : {
                    kind: "unavailable",
                    reason: "Delegated permission service/config unavailable.",
                  };
            }
          };
          const hostMaxSourcesPerBatch = host.maxSourcesPerBatch ?? 1;
          const requestedMaxSourcesPerBatch =
            resource?.maxSourcesPerBatch ?? hostMaxSourcesPerBatch;
          const maxSourcesPerBatch = Math.max(
            1,
            Math.min(MAX_SOURCES_PER_BATCH, requestedMaxSourcesPerBatch),
          );
          return {
            maxSourcesPerBatch,
            revision: currentRevision,
            nextTurn() {
              currentRevision();
              turn++;
              inTurn = true;
              cache.clear();
            },
            endTurn() {
              inTurn = false;
              cache.clear();
            },
            close: closeTask,
            check: (action) => check(action, "disclosure"),
            checkLocalSearch: (action) => check(action, "local-search"),
          };
        },
      };
    },
  };
  const retireOperations = async () => {
    const results = await Promise.allSettled([...operations.values()].map((close) => close()));
    operations.clear();
    for (const result of results) {
      if (result.status === "rejected") {
        host.cleanupError?.(result.reason);
      }
    }
  };
  return {
    service,
    retireOperations,
    async dispose() {
      lifetime.abort();
      await retireOperations();
    },
  };
}

export function permissionRevision(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
