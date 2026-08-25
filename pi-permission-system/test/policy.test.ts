import { describe, expect, it } from "vitest";
import { checkPolicy } from "#src/policy.ts";

describe("global policy", () => {
  const policy = {
    "*": "ask",
    read: "allow",
    bash: { "git status": "allow", "rm *": { action: "deny" as const, reason: "No deletion" } },
  } as const;
  it("uses the last matching rule", () => {
    expect(checkPolicy(policy, "bash", "git status")).toMatchObject({
      state: "allow",
      matchedPattern: "git status",
    });
    expect(checkPolicy(policy, "bash", "rm -rf x")).toMatchObject({
      state: "deny",
      reason: "No deletion",
    });
    expect(checkPolicy(policy, "write", "write")).toMatchObject({ state: "ask" });
  });
});
