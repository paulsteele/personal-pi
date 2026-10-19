import type { PermissionState, RuleValue } from "./config.ts";
import { wildcardMatch } from "./wildcard-matcher.ts";

export interface PolicyDecision {
  state: PermissionState;
  matchedPattern: string | null;
  reason: string | null;
}

/** Last matching global rule wins; absent policy is always an ask. */
export function checkPolicy(
  policy: Record<string, PermissionState | Record<string, RuleValue>>,
  surface: string,
  value: string,
): PolicyDecision {
  let result: PolicyDecision = { state: "ask", matchedPattern: null, reason: null };
  for (const [surfacePattern, surfaceRules] of Object.entries(policy)) {
    if (!wildcardMatch(surfacePattern, surface)) continue;
    const rules = typeof surfaceRules === "string" ? { "*": surfaceRules } : surfaceRules;
    for (const [pattern, rule] of Object.entries(rules)) {
      if (!wildcardMatch(pattern, value)) continue;
      result =
        typeof rule === "string"
          ? { state: rule, matchedPattern: pattern, reason: null }
          : { state: "deny", matchedPattern: pattern, reason: rule.reason ?? null };
    }
  }
  return result;
}
