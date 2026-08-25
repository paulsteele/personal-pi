export const PERMISSIONS_UI_PROMPT_CHANNEL = "permissions:ui_prompt";
export const PERMISSIONS_DECISION_CHANNEL = "permissions:decision";

export type DecisionSource =
  | { kind: "policy"; pattern: string | null }
  | { kind: "auto"; verdict: "allow" | "deny" }
  | { kind: "guard"; category: string }
  | { kind: "human" }
  | { kind: "unavailable" }
  | { kind: "gate_error" };

export interface PermissionUiPromptEvent {
  requestId: string;
  toolCallId: string | null;
  source: "tool_call" | "skill_input" | "skill_read";
  surface: string;
  value: string;
}

export interface PermissionDecisionEvent {
  requestId: string;
  toolCallId: string | null;
  surface: string;
  value: string;
  result: "allow" | "deny";
  resolution:
    | "policy_allow"
    | "policy_deny"
    | "auto_approved"
    | "auto_denied"
    | "user_approved"
    | "user_denied"
    | "guard_denied"
    | "confirmation_unavailable"
    | "gate_error";
  decidedBy: DecisionSource;
  category?: string | null;
  reason?: string | null;
  matchedPattern?: string | null;
}

export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export function emitUiPrompt(events: EventBus, event: PermissionUiPromptEvent): void {
  try {
    events.emit(PERMISSIONS_UI_PROMPT_CHANNEL, event);
  } catch {
    /* observational */
  }
}
export function emitDecision(events: EventBus, event: PermissionDecisionEvent): void {
  try {
    events.emit(PERMISSIONS_DECISION_CHANNEL, event);
  } catch {
    /* observational */
  }
}
