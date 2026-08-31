import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { BashCommandContext } from "../types.ts";
import type { PermissionPromptPayload } from "./payload.ts";

export interface PromptTheme {
  fg(color: string, text: string): string;
}

export interface RenderedPermissionPrompt {
  readonly lines: readonly string[];
  readonly elided: boolean;
}

interface Fact {
  label: string;
  text: string;
  color?: "policy_allow" | "warning";
  /** Backward compatibility for request entries persisted before semantic colors. */
  highlighted?: boolean;
}

const MAX_ROWS = 24;
const MAX_FIELD_CHARS = 400;

/** Render aligned upstream-style facts, warning-highlighting the gated command/path. */
export function renderPermissionPrompt(
  payload: PermissionPromptPayload,
  width: number,
  theme?: PromptTheme,
  expanded = false,
): RenderedPermissionPrompt {
  const facts = promptFacts(payload);
  const labelWidth = Math.max(0, ...facts.map((fact) => fact.label.length));
  const bounded = facts.map((fact) => ({
    ...fact,
    text: expanded ? fact.text : cap(fact.text, MAX_FIELD_CHARS),
    clipped: !expanded && fact.text.length > MAX_FIELD_CHARS,
  }));
  const blocks = bounded.map((fact) => {
    const indent = " ".repeat(labelWidth + 3);
    return fact.text.split("\n").flatMap((line, index) => {
      const color = fact.color ?? (fact.highlighted ? "warning" : undefined);
      const value =
        color && theme
          ? theme.fg(color === "policy_allow" ? "thinkingLow" : "warning", line)
          : line;
      const rendered = index === 0 ? `${fact.label.padEnd(labelWidth)} : ${value}` : indent + value;
      return fitLine(rendered, width);
    });
  });
  const all = blocks.flat();
  const clipped = bounded.some((fact) => fact.clipped);
  if (expanded || all.length <= MAX_ROWS) return { lines: all, elided: clipped };
  return { lines: [...all.slice(0, MAX_ROWS - 1), "…"], elided: true };
}

function promptFacts(payload: PermissionPromptPayload): Fact[] {
  const facts: Fact[] = [];
  if (payload.review.source === "classifier") {
    facts.push({ label: "󰚩 Classifier review", text: "Human approval requested" });
    facts.push({ label: "reason", text: payload.review.reason });
  } else if (payload.review.source === "guard") {
    facts.push({ label: "󰒃 Security check", text: payload.review.category });
    facts.push({ label: "reason", text: payload.review.reason });
  } else if (payload.review.reason) {
    facts.push({ label: "󰒃 Policy review", text: payload.review.reason });
  }
  const valueLabel =
    payload.surface === "bash"
      ? "command"
      : payload.surface === "skill"
        ? "skill"
        : payload.surface.includes("directory") || payload.surface === "path"
          ? "path"
          : "value";
  if (payload.toolName) facts.push({ label: "tool", text: payload.toolName });
  if (payload.surface !== payload.toolName && payload.surface !== valueLabel)
    facts.push({ label: "surface", text: payload.surface });
  if (payload.matchedPattern) facts.push({ label: "rule", text: payload.matchedPattern });
  if (payload.category && payload.review.source !== "guard")
    facts.push({ label: "safety", text: payload.category });
  if (payload.reason && !payload.review.reason)
    facts.push({ label: "reason", text: payload.reason });
  if (payload.value && payload.value !== payload.toolName)
    facts.push({ label: valueLabel, text: payload.value, color: "warning" });
  if (payload.executedUnit && payload.executedUnit !== payload.value)
    facts.push({ label: "runs", text: payload.executedUnit, color: "warning" });
  if (payload.commandContext)
    facts.push({ label: "context", text: contextText(payload.commandContext) });
  for (const evidence of payload.evidence)
    facts.push({
      label: evidence.label,
      text: evidence.detail ? `${evidence.text} → ${evidence.detail}` : evidence.text,
      color: evidence.color,
      highlighted: evidence.highlighted,
    });
  return facts;
}

function contextText(context: BashCommandContext): string {
  switch (context) {
    case "command_substitution":
      return "command substitution";
    case "process_substitution":
      return "process substitution";
    case "subshell":
      return "subshell";
  }
}

function cap(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function fitLine(line: string, width: number): string[] {
  if (width <= 0) return [];
  return wrapTextWithAnsi(line, width).map((part) => truncateToWidth(part, width));
}
