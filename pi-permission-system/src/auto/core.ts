export type Verdict = { kind: "allow" };

export type ReviewEscalationCause =
  | "classifier"
  | "timeout"
  | "model-unavailable"
  | "auth-unavailable"
  | "call-failed"
  | "malformed-response";

export type ModelReviewResult =
  | { kind: "allow"; modelCalled: boolean }
  | {
      kind: "require_human";
      reason: string;
      cause: ReviewEscalationCause;
      modelCalled: boolean;
    }
  | { kind: "cancelled"; modelCalled: boolean };

export type DecisionRecord = {
  requestId: string;
  mechanism: "guard" | "model";
  category: string | null;
  surface: string;
  value: string;
  verdict: "allow" | "require_human";
  reason: string | null;
  cause: ReviewEscalationCause | null;
  at: number;
};
export type AutoModeSnapshot = {
  enabled: boolean;
  usable: boolean;
  modelId: string;
  allowed: number;
  asked: number;
};
export function footerLabel(snapshot: AutoModeSnapshot): string {
  return snapshot.enabled
    ? `⏵⏵ auto${snapshot.allowed || snapshot.asked ? ` 󰚩 ${snapshot.allowed} · 󰀄 ${snapshot.asked}` : ""}`
    : "⏸ manual";
}
