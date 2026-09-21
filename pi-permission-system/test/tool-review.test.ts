import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "#src/config.ts";
import { reviewToolCall, type ToolReviewHost, type ToolReviewRequest } from "#src/tool-review.ts";

function harness(permission: typeof DEFAULT_CONFIG.permission, auto = true) {
  let config = {
    ...DEFAULT_CONFIG,
    permission,
    auto: { ...DEFAULT_CONFIG.auto, enabledByDefault: auto },
  };
  const model = vi.fn(async () => ({ kind: "allow" as const, modelCalled: true }));
  const human = vi.fn(async () => ({ allowed: false, reason: "Human denied permission." }));
  const host: ToolReviewHost = {
    refresh: () => ({
      config,
      revision: JSON.stringify(config),
      contextRevision: "notes",
      skills: [],
      directories: new Set(),
      files: new Set(),
    }),
    model,
    human,
    decision: vi.fn(),
    review: vi.fn(),
    count: vi.fn(),
  };
  return {
    host,
    model,
    human,
    set: (next: typeof config) => {
      config = next;
    },
    get: () => config,
  };
}
const read: ToolReviewRequest = {
  cwd: "/repo",
  toolName: "read",
  input: { path: "/repo/a.ts" },
  toolCallId: "call",
};

describe("context-explicit tool evaluation", () => {
  it.each(["main", "reviewer"])("preserves routing for %s", async (actor) => {
    const request = { ...read, ...(actor === "main" ? {} : { agentName: actor }) };
    const allow = harness({ "*": "allow" });
    expect((await reviewToolCall(request, allow.host)).kind).toBe("allowed");
    expect(allow.model).not.toHaveBeenCalled();
    const deny = harness({ "*": "allow", path: { "*": "deny" } });
    expect((await reviewToolCall(request, deny.host)).kind).toBe("denied");
    expect(deny.model).not.toHaveBeenCalled();
    expect(deny.human).not.toHaveBeenCalled();
    const ask = harness({ "*": "ask" });
    expect((await reviewToolCall(request, ask.host)).kind).toBe("allowed");
    expect(ask.model).toHaveBeenCalledTimes(1);
    const manual = harness({ "*": "ask" }, false);
    expect((await reviewToolCall(request, manual.host)).kind).toBe("denied");
    expect(manual.model).not.toHaveBeenCalled();
    expect(manual.human).toHaveBeenCalledTimes(1);
  });

  it("keeps sensitive paths human-only even with policy allow and delegated read aliases", async () => {
    const h = harness({ "*": "allow" });
    expect(
      (
        await reviewToolCall(
          { ...read, toolName: "read_before", input: {}, effects: [{ path: "/repo/.env" }] },
          h.host,
        )
      ).kind,
    ).toBe("denied");
    expect(h.model).not.toHaveBeenCalled();
    expect(h.human).toHaveBeenCalledTimes(1);
  });

  it("combines explicit alias/read policies and all declared paths before escalation", async () => {
    for (const permission of [
      { "*": "allow", read: "deny" },
      { "*": "allow", read_before: "deny" },
      { "*": "allow", path: { "*": "allow", "secret.ts": "deny" } },
    ] as Array<typeof DEFAULT_CONFIG.permission>) {
      const h = harness(permission);
      expect(
        (
          await reviewToolCall(
            {
              ...read,
              toolName: "read_before",
              input: {},
              effects: [{ path: "/repo/a.ts" }, { path: "/repo/secret.ts" }],
            },
            h.host,
          )
        ).kind,
      ).toBe("denied");
      expect(h.model).not.toHaveBeenCalled();
    }
  });

  it("discards a late classifier allow after the policy changes", async () => {
    const h = harness({ "*": "ask" });
    h.model.mockImplementationOnce(async () => {
      h.set({ ...h.get(), permission: { "*": "deny" } });
      return { kind: "allow", modelCalled: true };
    });
    expect((await reviewToolCall(read, h.host)).kind).toBe("denied");
    expect(h.host.count).not.toHaveBeenCalled();
  });

  it("routes a late auto allow to human when auto was turned off", async () => {
    const h = harness({ "*": "ask" });
    h.model.mockImplementationOnce(async () => {
      h.set({ ...h.get(), auto: { ...h.get().auto, enabledByDefault: false } });
      return { kind: "allow", modelCalled: true };
    });
    expect((await reviewToolCall(read, h.host)).kind).toBe("denied");
    expect(h.human).toHaveBeenCalledTimes(1);
  });

  it("fails closed on configuration errors and cancellation", async () => {
    const h = harness({ "*": "allow" });
    h.host.refresh = () => {
      throw new Error("bad config");
    };
    expect((await reviewToolCall(read, h.host)).kind).toBe("unavailable");
    expect((await reviewToolCall({ ...read, signal: AbortSignal.abort() }, h.host)).kind).toBe(
      "cancelled",
    );
  });
});
