import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { posix } from "node:path";
import type { AccessPath } from "./access-intent/access-path.ts";
import { BashProgram } from "./access-intent/bash/program.ts";
import type { ReviewFacts } from "./auto/classifier.ts";
import type { DecisionRecord, ModelReviewResult } from "./auto/core.ts";
import { evaluateSafety, type SafetyContext } from "./auto/safety-policy.ts";
import type { Config } from "./config.ts";
import { PathNormalizer } from "./path-normalizer.ts";
import type { PermissionDecisionEvent, DelegatedPermissionIdentity } from "./permission-events.ts";
import { checkPolicy, type PolicyDecision } from "./policy.ts";
import { formatEditForHuman } from "./prompt/edit-preview.ts";
import {
  buildPermissionPromptPayload,
  type PermissionPromptPayload,
  type PermissionReview,
} from "./prompt/payload.ts";

export interface ActiveSkill {
  name: string;
  filePath: string;
  baseDir: string;
}

/** Host-declared source effects, never a model-supplied claim about what a tool does. */
export interface ReadEffect {
  path: string;
  side?: "old" | "new";
  version?: string;
  range?: string;
}

export interface ToolReviewRequest {
  toolName: string;
  input: unknown;
  cwd: string;
  toolCallId: string;
  signal?: AbortSignal;
  skillInput?: string;
  agentName?: string;
  description?: string;
  effects?: readonly ReadEffect[];
  /** Trusted PR host scan only; approval to disclose matches is a separate read. */
  localSearch?: true;
}

export interface ReviewState {
  config: Config;
  /** Includes ordered policy and classifier configuration, not a permission grant. */
  revision: string;
  contextRevision: string;
  skills: readonly ActiveSkill[];
  directories: ReadonlySet<string>;
  files: ReadonlySet<string>;
}

export interface HumanReviewRequest {
  id: string;
  toolCallId: string;
  surface: string;
  value: string;
  pattern: string | null;
  category?: string;
  reason?: string;
  source: "tool_call" | "skill_input" | "skill_read";
  payload: PermissionPromptPayload;
  allowDirectory?: string;
  signal?: AbortSignal;
  delegated?: DelegatedPermissionIdentity;
  /** Check again when the request reaches the front of the UI queue. */
  isCurrent(includeContext?: boolean): boolean;
}

export interface ToolReviewHost {
  refresh(): ReviewState;
  model(
    request: ToolReviewRequest,
    state: ReviewState,
    id: string,
    facts: ReviewFacts,
    risks: readonly string[],
  ): Promise<ModelReviewResult>;
  human(
    request: HumanReviewRequest,
  ): Promise<{ allowed: boolean; reason: string | null; stale?: boolean; unavailable?: boolean }>;
  decision(event: PermissionDecisionEvent): void;
  review(event: DecisionRecord, toolCallId: string | null): void;
  count(kind: "allowed" | "asked"): void;
}

export type ToolReviewResult =
  | { kind: "allowed"; revision: string }
  | { kind: "denied" | "cancelled" | "unavailable"; reason: string };

interface PolicyCheck {
  surface: string;
  value: string;
  decision: PolicyDecision;
  path?: AccessPath;
}

function inputPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const direct = typeof record.path === "string" ? record.path : record.file_path;
  if (typeof direct === "string" && direct.trim()) return direct;
  return record.arguments && typeof record.arguments === "object"
    ? inputPath({ ...(record.arguments as object), arguments: undefined })
    : null;
}

function policyForCall(
  state: ReviewState,
  request: ToolReviewRequest,
  normalizer: PathNormalizer,
  command: string | null,
  program: BashProgram | null,
  directPath: string | null,
  skillNames: readonly string[],
): PolicyCheck {
  if (request.skillInput)
    return {
      surface: "skill",
      value: request.skillInput,
      decision: checkPolicy(state.config.permission, "skill", request.skillInput),
    };
  const checks: PolicyCheck[] = [];
  const add = (surface: string, value: string, path?: AccessPath) => {
    if (
      (surface === "path" || surface === "external_directory") &&
      !(surface in state.config.permission)
    )
      return;
    const aliases = path?.matchValues() ?? [value];
    const decisions = aliases.map((alias) => checkPolicy(state.config.permission, surface, alias));
    const explicitDeny = decisions.find((decision) => decision.state === "deny");
    const grant =
      surface === "external_directory"
        ? path && state.files.has(path.boundaryValue())
          ? "<session-file>"
          : aliases.some((alias) =>
                [...state.directories].some((dir) => alias === dir || alias.startsWith(`${dir}/`)),
              )
            ? "<session-directory>"
            : null
        : null;
    const decision =
      explicitDeny ??
      (grant ? { state: "allow" as const, matchedPattern: grant, reason: null } : undefined) ??
      decisions.find((candidate) => candidate.state === "allow") ??
      decisions[0] ??
      checkPolicy(state.config.permission, surface, value);
    checks.push({ surface, value, decision, ...(path ? { path } : {}) });
  };
  const addPath = (value: string) => {
    const path = normalizer.forPath(value);
    add("path", value, path);
    if (normalizer.isOutsideWorkingDirectory(value)) add("external_directory", value, path);
  };
  if (request.localSearch) add("search_source", "search_source");
  for (const skillName of skillNames) add("skill", skillName);
  if (directPath) addPath(directPath);
  for (const effect of request.effects ?? []) addPath(effect.path);
  if (request.effects?.length) add("read", "read");
  for (const candidate of program?.pathRuleCandidates() ?? [])
    add("path", candidate.path.value(), candidate.path);
  for (const path of program?.externalPaths() ?? []) add("external_directory", path.value(), path);
  if (command) {
    for (const unit of program?.commands() ?? []) add("bash", unit.text);
    add("bash", command);
  } else add(request.toolName, request.toolName);
  const rank = (state: PolicyDecision["state"]) => (state === "deny" ? 2 : state === "ask" ? 1 : 0);
  return checks.reduce((worst, item) =>
    rank(item.decision.state) > rank(worst.decision.state) ? item : worst,
  );
}

function isRepositoryLocalSearch(request: ToolReviewRequest): boolean {
  const path = inputPath(request.input);
  return (
    request.toolName === "read" &&
    !!request.agentName &&
    !request.skillInput &&
    !!path &&
    request.effects?.length === 1 &&
    request.effects[0]?.path === path &&
    !new PathNormalizer(request.cwd).isOutsideWorkingDirectory(path)
  );
}

function externalDirectory(value: string, normalizer: PathNormalizer): string | undefined {
  const path = normalizer.forPath(value).boundaryValue() || normalizer.comparableValue(value);
  if (!path || !posix.isAbsolute(path) || path === "/") return undefined;
  try {
    return statSync(path).isDirectory() ? path : posix.dirname(path);
  } catch {
    return path;
  }
}

async function prepare(request: ToolReviewRequest, state: ReviewState, id: string) {
  const normalizer = new PathNormalizer(request.cwd);
  const input = request.input;
  const command =
    request.toolName === "bash" &&
    input &&
    typeof input === "object" &&
    typeof (input as Record<string, unknown>).command === "string"
      ? (input as { command: string }).command
      : null;
  const program = command ? await BashProgram.parse(command, normalizer) : null;
  const directPath = inputPath(input);
  const readPaths =
    request.toolName === "read" || request.effects?.length
      ? [
          ...(directPath ? [directPath] : []),
          ...(request.effects ?? []).map((effect) => effect.path),
        ]
      : [];
  const skillNames = [
    ...new Set(
      readPaths.flatMap((path) => {
        const normalized =
          normalizer.forPath(path).boundaryValue() || normalizer.comparableValue(path);
        const skill = state.skills
          .filter((skill) => {
            const file =
              normalizer.forPath(skill.filePath).boundaryValue() ||
              normalizer.comparableValue(skill.filePath);
            const base =
              normalizer.forPath(skill.baseDir).boundaryValue() ||
              normalizer.comparableValue(skill.baseDir);
            return normalized === file || normalizer.isWithinDirectory(normalized, base);
          })
          .sort((a, b) => b.baseDir.length - a.baseDir.length)[0];
        return skill ? [skill.name] : [];
      }),
    ),
  ];
  const paths = [
    ...(directPath ? [normalizer.forPath(directPath)] : []),
    ...(request.effects ?? []).map((effect) => normalizer.forPath(effect.path)),
    ...(program?.pathRuleCandidates().map((entry) => entry.path) ?? []),
    ...(program?.externalPaths() ?? []),
  ];
  const context: SafetyContext = {
    requestId: id,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    agentName: request.agentName ?? null,
    input,
    cwd: request.cwd,
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
  let safety = evaluateSafety(context, state.config.auto.enabledByDefault, {
    home: process.env.HOME ?? "",
  });
  const selected = policyForCall(
    state,
    request,
    normalizer,
    command,
    program,
    directPath,
    skillNames,
  );
  const pathFacts = [
    ...new Map(
      paths.map((path) => [path.value(), { value: path.value(), resolved: path.boundaryValue() }]),
    ).values(),
  ];
  if (
    safety.kind !== "require_human" &&
    (pathFacts.length > 32 ||
      pathFacts.some((path) => path.value.length > 2000 || path.resolved.length > 2000))
  ) {
    safety = {
      kind: "require_human",
      category: "path_scope_preview",
      reason: "Path scope exceeds the complete classifier preview; human review is required.",
      riskMarkers: safety.riskMarkers,
    };
  }
  let facts: ReviewFacts = {
    paths: pathFacts,
    surface: selected.surface,
    toolName: request.skillInput ? null : request.toolName,
    invokedToolName: selected.surface === "skill" ? selected.value : null,
    value: selected.value,
    matchedPattern: selected.decision.matchedPattern,
    commandContext: null,
    executedUnit: null,
    agentName: request.agentName ?? null,
    ...(selected.path
      ? {
          path: {
            resolved: selected.path.boundaryValue(),
            withinTmp: normalizer.isWithinDirectory(
              selected.path.boundaryValue(),
              normalizer.forPath("/tmp").boundaryValue(),
            ),
          },
        }
      : {}),
    // File bodies belong only in human previews, never classifier evidence.
    evidence: command
      ? [{ label: "full command", text: command, detail: null }]
      : request.description
        ? [
            {
              label: "delegated action (not user authority)",
              text: request.description,
              detail: null,
            },
          ]
        : [],
  };
  if (request.effects?.length)
    facts = {
      ...facts,
      evidence: [
        ...facts.evidence,
        {
          label: "captured source metadata",
          text: JSON.stringify(request.effects),
          detail: null,
        },
      ],
    };
  const payload = (review: PermissionReview): PermissionPromptPayload => {
    const value = buildPermissionPromptPayload({
      surface: selected.surface,
      value: selected.value,
      matchedPattern: selected.decision.matchedPattern,
      review,
      toolName: request.toolName,
      command,
      cwd: request.cwd,
      ...(review.source === "guard" ? { category: review.category } : {}),
      reason: review.reason ?? undefined,
      commandUnits: program?.guardCommands().map((unit) => ({
        ...unit,
        policyState: checkPolicy(state.config.permission, "bash", unit.text).state,
      })),
      paths: paths.map((path) => ({ value: path.value(), resolved: path.resolvedAlias() })),
      inputPreview:
        request.toolName === "edit" && input && typeof input === "object"
          ? formatEditForHuman(input as Record<string, unknown>)
          : undefined,
    });
    return request.agentName
      ? {
          ...value,
          evidence: [
            { label: "worker", text: request.agentName, detail: request.description ?? null },
            ...value.evidence,
          ],
        }
      : value;
  };
  return {
    selected,
    safety,
    facts,
    payload,
    source: request.skillInput
      ? ("skill_input" as const)
      : skillNames.length
        ? ("skill_read" as const)
        : ("tool_call" as const),
    allowDirectory:
      !request.agentName && selected.surface === "external_directory"
        ? externalDirectory(selected.value, normalizer)
        : undefined,
  };
}

export function reviewRevision(state: Pick<ReviewState, "revision" | "contextRevision">): string {
  return createHash("sha256")
    .update(JSON.stringify([state.revision, state.contextRevision]))
    .digest("hex");
}

/** The single routing implementation. Hosts supply UI/model ports, never a forged ExtensionContext. */
export async function reviewToolCall(
  request: ToolReviewRequest,
  host: ToolReviewHost,
): Promise<ToolReviewResult> {
  const baseId = `perm-${request.agentName ? randomUUID() : request.toolCallId || randomUUID()}`;
  let lastEvent:
    | { requestId: string; toolCallId: string | null; surface: string; value: string }
    | undefined;
  const stopped = (kind: "cancelled" | "unavailable"): ToolReviewResult => {
    const reason =
      kind === "cancelled"
        ? "Permission review cancelled."
        : "Permission service/config unavailable; action blocked.";
    if (lastEvent)
      host.decision({
        ...lastEvent,
        result: "deny",
        reason,
        resolution: kind === "cancelled" ? "confirmation_unavailable" : "gate_error",
        decidedBy: { kind: kind === "cancelled" ? "unavailable" : "gate_error" },
      });
    return { kind, reason };
  };
  try {
    for (let attempt = 0; ; attempt++) {
      if (request.signal?.aborted) return stopped("cancelled");
      const state = host.refresh();
      const id = attempt ? `${baseId}-${attempt}` : baseId;
      const { selected, safety, facts, payload, source, allowDirectory } = await prepare(
        request,
        state,
        id,
      );
      const current = (includeContext = true) => {
        if (request.signal?.aborted) return false;
        const next = host.refresh();
        return (
          state.revision === next.revision &&
          (!includeContext || state.contextRevision === next.contextRevision)
        );
      };
      if (!current()) continue;
      const event = {
        requestId: id,
        toolCallId: request.toolCallId || null,
        surface: selected.surface,
        value: selected.value,
      };
      lastEvent = event;
      const finish = (
        decision: Omit<PermissionDecisionEvent, keyof typeof event>,
        reason?: string,
      ): ToolReviewResult => {
        const revision = reviewRevision(
          decision.resolution === "user_approved" ? host.refresh() : state,
        );
        host.decision({ ...event, ...decision });
        return decision.result === "allow"
          ? { kind: "allowed", revision }
          : { kind: "denied", reason: reason ?? decision.reason ?? "Human denied permission." };
      };
      const stale = () => {
        host.decision({
          ...event,
          result: "deny",
          resolution: "gate_error",
          decidedBy: { kind: "gate_error" },
          reason: "Permission context changed; the pending action is being re-evaluated.",
        });
        lastEvent = undefined;
      };
      const policy = selected.decision;
      if (policy.state === "deny")
        return finish(
          {
            result: "deny",
            resolution: "policy_deny",
            decidedBy: { kind: "policy", pattern: policy.matchedPattern },
            matchedPattern: policy.matchedPattern,
            reason: policy.reason,
          },
          "Denied by permission policy.",
        );
      if (request.localSearch) {
        const blocked =
          safety.kind === "require_human"
            ? safety.reason
            : !isRepositoryLocalSearch(request)
              ? "Local search requires one repository-contained source read."
              : null;
        return finish({
          result: blocked ? "deny" : "allow",
          resolution: blocked ? "local_search_blocked" : "local_search_allowed",
          decidedBy:
            safety.kind === "require_human"
              ? { kind: "guard", category: safety.category }
              : { kind: "policy", pattern: policy.matchedPattern },
          reason: blocked,
        });
      }
      const unresolved = safety.riskMarkers.includes("unresolved-path-expression");
      if (safety.kind !== "require_human" && policy.state === "allow" && !unresolved)
        return finish({
          result: "allow",
          resolution: "policy_allow",
          decidedBy: { kind: "policy", pattern: policy.matchedPattern },
          matchedPattern: policy.matchedPattern,
        });
      let review: PermissionReview = {
        source: "policy",
        reason: unresolved
          ? "A filesystem path contains a shell expansion that could not be resolved statically."
          : policy.reason,
      };
      if (safety.kind === "require_human") {
        review = { source: "guard", reason: safety.reason, category: safety.category };
        host.review(
          {
            requestId: id,
            mechanism: "guard",
            category: safety.category,
            surface: request.toolName,
            value: selected.value,
            verdict: "require_human",
            reason: safety.reason,
            cause: null,
            at: Date.now(),
          },
          request.toolCallId || null,
        );
      } else if (state.config.auto.enabledByDefault) {
        const verdict = await host.model(request, state, id, facts, safety.riskMarkers);
        if (verdict.kind === "cancelled" || request.signal?.aborted) return stopped("cancelled");
        if (!current()) {
          stale();
          continue;
        }
        if (verdict.kind === "allow") {
          host.count("allowed");
          return finish({
            result: "allow",
            resolution: "auto_approved",
            decidedBy: { kind: "auto", verdict: "allow" },
          });
        }
        host.count("asked");
        review = { source: "classifier", reason: verdict.reason, cause: verdict.cause };
      }
      const human = await host.human({
        id,
        toolCallId: request.toolCallId,
        surface: safety.kind === "require_human" ? request.toolName : selected.surface,
        value: selected.value,
        pattern:
          safety.kind === "require_human" ? `<guard:${safety.category}>` : policy.matchedPattern,
        source,
        payload: payload(review),
        signal: request.signal,
        isCurrent: current,
        ...(safety.kind === "require_human"
          ? { category: safety.category, reason: safety.reason }
          : allowDirectory
            ? { allowDirectory }
            : {}),
      });
      if (request.signal?.aborted) return stopped("cancelled");
      // A note attached to this answer is deliberately for subsequent actions, not a reason to ask twice.
      if (human.stale || !current(false)) {
        stale();
        continue;
      }
      return finish(
        {
          result: human.allowed ? "allow" : "deny",
          resolution: human.unavailable
            ? "confirmation_unavailable"
            : human.allowed
              ? "user_approved"
              : "user_denied",
          decidedBy: { kind: human.unavailable ? "unavailable" : "human" },
          reason: human.reason,
          ...(safety.kind === "require_human" ? { category: safety.category } : {}),
        },
        human.reason ?? undefined,
      );
    }
  } catch {
    return stopped(request.signal?.aborted ? "cancelled" : "unavailable");
  }
}
