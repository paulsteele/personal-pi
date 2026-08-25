export type Verdict = { kind: "allow" | "deny" | "defer"; reason?: string };
export const DEFER: Verdict = { kind: "defer" };
export type DecisionRecord = {
  requestId: string;
  mechanism: "guard" | "model";
  category: string | null;
  surface: string;
  value: string;
  verdict: "allow" | "deny" | "defer";
  reason: string | null;
  deferReason: string | null;
  at: number;
};
export type AutoModeSnapshot = {
  enabled: boolean;
  usable: boolean;
  modelId: string;
  allowed: number;
  denied: number;
  escalated: number;
};
export function footerLabel(snapshot: AutoModeSnapshot): string {
  return snapshot.enabled
    ? `⏵⏵ auto${snapshot.allowed || snapshot.denied ? ` ${snapshot.allowed}/${snapshot.denied}` : ""}`
    : "⏸ manual";
}
