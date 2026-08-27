import type { BashCommandContext } from "../types.ts";

export type PermissionReview =
  | { readonly source: "policy"; readonly reason?: string | null }
  | {
      readonly source: "classifier";
      readonly reason: string;
      readonly cause?: string | null;
    }
  | {
      readonly source: "guard";
      readonly reason: string;
      readonly category: string;
    };

/** Complete, presentation-neutral facts for one local permission prompt. */
export interface PermissionPromptPayload {
  readonly surface: string;
  readonly toolName: string | null;
  readonly value: string;
  readonly matchedPattern: string | null;
  readonly category: string | null;
  readonly reason: string | null;
  readonly review: PermissionReview;
  readonly commandContext: BashCommandContext | null;
  readonly executedUnit: string | null;
  readonly evidence: readonly PermissionPromptEvidence[];
}

export interface PermissionPromptEvidence {
  readonly label: string;
  readonly text: string;
  readonly detail: string | null;
  /** Paint this decision-relevant command/path section with the warning color. */
  readonly highlighted?: boolean;
}

export interface RichPromptFacts {
  readonly surface: string;
  readonly value: string;
  readonly matchedPattern: string | null;
  readonly category?: string;
  readonly reason?: string;
  readonly review?: PermissionReview;
  readonly toolName?: string | null;
  readonly command?: string | null;
  readonly cwd?: string;
  readonly commandUnits?: readonly {
    readonly text: string;
    readonly context?: BashCommandContext;
    readonly executedUnit?: string;
  }[];
  readonly paths?: readonly {
    readonly value: string;
    readonly resolved?: string;
  }[];
  readonly inputPreview?: string;
}

/** Build the rich prompt projection from facts already computed by the gate. */
export function buildPermissionPromptPayload(facts: RichPromptFacts): PermissionPromptPayload {
  const evidence: PermissionPromptEvidence[] = [];
  const seen = new Set<string>();
  const add = (
    label: string,
    text: string | null | undefined,
    detail: string | null = null,
    highlighted = false,
  ): void => {
    if (!text?.trim()) return;
    const key = `${label}\0${text}\0${detail ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push({ label, text, detail, highlighted });
  };

  if (facts.command && facts.command !== facts.value)
    add("full command", facts.command, null, true);
  for (const unit of facts.commandUnits ?? []) {
    if (unit.text !== facts.command && unit.text !== facts.value)
      add(
        unit.context ? `${contextLabel(unit.context)} command` : "command unit",
        unit.text,
        unit.executedUnit ?? null,
        true,
      );
  }
  for (const path of facts.paths ?? [])
    add(
      "path",
      path.value,
      path.resolved && path.resolved !== path.value ? path.resolved : null,
      true,
    );
  if (facts.cwd && (facts.surface === "external_directory" || Boolean(facts.command)))
    add("working directory", facts.cwd);
  add("input", facts.inputPreview);

  const matchingUnit = facts.commandUnits?.find((unit) => unit.text === facts.value);
  const review =
    facts.review ??
    ({ source: "policy", ...(facts.reason ? { reason: facts.reason } : {}) } as const);
  return {
    surface: facts.surface,
    toolName: facts.toolName ?? null,
    value: facts.value,
    matchedPattern: facts.matchedPattern,
    category: facts.category ?? null,
    reason: facts.reason ?? null,
    review,
    commandContext: matchingUnit?.context ?? null,
    executedUnit: matchingUnit?.executedUnit ?? null,
    evidence,
  };
}

/** Bound data before it is persisted as a TUI-only transcript entry. */
export function boundPermissionPromptPayload(
  payload: PermissionPromptPayload,
): PermissionPromptPayload {
  const bounded = (value: string | null, max: number): string | null =>
    value === null ? null : Array.from(value).slice(0, max).join("");
  const review: PermissionReview =
    payload.review.source === "classifier"
      ? {
          source: "classifier",
          reason: bounded(payload.review.reason, 500) ?? "Human approval requested.",
          cause: bounded(payload.review.cause ?? null, 100),
        }
      : payload.review.source === "guard"
        ? {
            source: "guard",
            reason: bounded(payload.review.reason, 500) ?? "Human approval requested.",
            category: bounded(payload.review.category, 100) ?? "security",
          }
        : { source: "policy", reason: bounded(payload.review.reason ?? null, 500) };
  return {
    surface: bounded(payload.surface, 100) ?? "unknown",
    toolName: bounded(payload.toolName, 100),
    value: bounded(payload.value, 2_000) ?? "",
    matchedPattern: bounded(payload.matchedPattern, 500),
    category: bounded(payload.category, 100),
    reason: bounded(payload.reason, 500),
    review,
    commandContext: payload.commandContext,
    executedUnit: bounded(payload.executedUnit, 2_000),
    evidence: payload.evidence.slice(0, 12).map((item) => ({
      label: bounded(item.label, 100) ?? "detail",
      text: bounded(item.text, 2_000) ?? "",
      detail: bounded(item.detail, 2_000),
      highlighted: item.highlighted,
    })),
  };
}

function contextLabel(context: BashCommandContext): string {
  switch (context) {
    case "command_substitution":
      return "substitution";
    case "process_substitution":
      return "process substitution";
    case "subshell":
      return "subshell";
  }
}
