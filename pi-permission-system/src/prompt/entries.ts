import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { HumanPromptChoice } from "./component.ts";
import {
  boundPermissionPromptPayload,
  type PermissionPromptPayload,
  type PermissionReview,
} from "./payload.ts";
import { renderPermissionPrompt } from "./renderer.ts";

export const PERMISSION_REQUEST_ENTRY = "pi-permission-system:permission-request:v1";
export const PERMISSION_OUTCOME_ENTRY = "pi-permission-system:permission-outcome:v1";

export interface PermissionRequestEntry {
  readonly version: 1;
  readonly requestId: string;
  readonly toolCallId: string | null;
  readonly payload: PermissionPromptPayload;
}

export interface PermissionOutcomeEntry {
  readonly version: 1;
  readonly requestId: string;
  readonly toolCallId: string | null;
  readonly allowed: boolean;
}

export function appendPermissionRequest(
  pi: Pick<ExtensionAPI, "appendEntry">,
  requestId: string,
  toolCallId: string | null,
  payload: PermissionPromptPayload,
): void {
  pi.appendEntry<PermissionRequestEntry>(PERMISSION_REQUEST_ENTRY, {
    version: 1,
    requestId: boundedId(requestId),
    toolCallId: toolCallId ? boundedId(toolCallId) : null,
    payload: boundPermissionPromptPayload(payload),
  });
}

export function appendPermissionOutcome(
  pi: Pick<ExtensionAPI, "appendEntry">,
  requestId: string,
  toolCallId: string | null,
  choice: HumanPromptChoice | null,
): void {
  pi.appendEntry<PermissionOutcomeEntry>(PERMISSION_OUTCOME_ENTRY, {
    version: 1,
    requestId: boundedId(requestId),
    toolCallId: toolCallId ? boundedId(toolCallId) : null,
    allowed: choice === "approve" || choice === "approve_note",
  });
}

export function registerPermissionEntryRenderers(
  pi: Pick<ExtensionAPI, "registerEntryRenderer">,
): void {
  pi.registerEntryRenderer<PermissionRequestEntry>(
    PERMISSION_REQUEST_ENTRY,
    (entry, options, theme) => {
      const data = entry.data;
      if (!isRequestEntry(data)) return undefined;
      const source = reviewTransition(data.payload.review);
      return new PermissionRequestEntryComponent(data.payload, options.expanded, source, theme);
    },
  );
  pi.registerEntryRenderer<PermissionOutcomeEntry>(
    PERMISSION_OUTCOME_ENTRY,
    (entry, _options, theme) => {
      const data = entry.data;
      if (!isOutcomeEntry(data)) return undefined;
      const outcome = data.allowed
        ? theme.fg("success", "✓ approved once")
        : theme.fg("error", "✕ denied");
      return new Text(`${theme.fg("syntaxType", "󰀄")} ${outcome}`, 0, 0);
    },
  );
}

class PermissionRequestEntryComponent extends Text {
  constructor(
    private readonly payload: PermissionPromptPayload,
    private readonly expanded: boolean,
    private readonly source: {
      icon: string;
      label: string;
      color: "warning" | "thinkingHigh" | "thinkingLow";
    },
    private readonly theme: Parameters<Parameters<ExtensionAPI["registerEntryRenderer"]>[1]>[2],
  ) {
    super("", 0, 0);
  }

  override render(width: number): string[] {
    const rendered = renderPermissionPrompt(this.payload, width, this.theme, this.expanded);
    const lines = [
      `${this.theme.fg(this.source.color, this.source.icon)} ${this.theme.fg("accent", this.source.label)}`,
      ...rendered.lines,
    ];
    if (rendered.elided && !this.expanded)
      lines.push(this.theme.fg("dim", "Ctrl+O expands this recorded request"));
    return lines;
  }
}

function reviewTransition(review: PermissionReview): {
  icon: string;
  label: string;
  color: "warning" | "thinkingHigh" | "thinkingLow";
} {
  if (review.source === "classifier")
    return { icon: "󰚩 ? → 󰀄", label: "Permission request", color: "thinkingHigh" };
  if (review.source === "guard")
    return { icon: "󰒃 ? → 󰀄", label: "Permission request", color: "warning" };
  return { icon: "󰒃 ? → 󰀄", label: "Permission request", color: "thinkingLow" };
}

function boundedId(value: string): string {
  return Array.from(value).slice(0, 160).join("");
}
function isRequestEntry(value: unknown): value is PermissionRequestEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { requestId?: unknown }).requestId === "string" &&
    typeof (value as { payload?: unknown }).payload === "object" &&
    (value as { payload?: unknown }).payload !== null
  );
}
function isOutcomeEntry(value: unknown): value is PermissionOutcomeEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { requestId?: unknown }).requestId === "string" &&
    typeof (value as { allowed?: unknown }).allowed === "boolean"
  );
}
