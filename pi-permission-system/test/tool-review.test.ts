import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "#src/config.ts";
import { reviewToolCall, type ToolReviewHost, type ToolReviewRequest } from "#src/tool-review.ts";

function harness(permission: typeof DEFAULT_CONFIG.permission, auto = true) {
  let config = {
    ...DEFAULT_CONFIG,
    permission,
    auto: { ...DEFAULT_CONFIG.auto, enabledByDefault: auto },
  };
  const model = vi.fn<ToolReviewHost["model"]>(async () => ({ kind: "allow", modelCalled: true }));
  const human = vi.fn<ToolReviewHost["human"]>(async () => ({
    allowed: false,
    reason: "Human denied permission.",
  }));
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

  it.each([true, false])("retains edit bodies only in human previews (auto=%s)", async (auto) => {
    const h = harness({ "*": "ask" }, auto);
    h.model.mockResolvedValue({
      kind: "require_human",
      reason: "The target is outside the requested scope.",
      cause: "classifier",
      modelCalled: true,
    });
    const request = {
      ...read,
      toolName: "edit",
      input: {
        path: "/repo/a.ts",
        edits: [{ oldText: "OLD_BODY_SENTINEL", newText: "NEW_BODY_SENTINEL" }],
      },
    };
    expect((await reviewToolCall(request, h.host)).kind).toBe("denied");
    expect(h.model).toHaveBeenCalledTimes(auto ? 1 : 0);
    if (auto) {
      const facts = h.model.mock.calls[0]?.[3];
      expect(facts).toMatchObject({ toolName: "edit", evidence: [] });
      expect(JSON.stringify(facts)).not.toContain("BODY_SENTINEL");
    }
    const preview = h.human.mock.calls[0]?.[0].payload.evidence.find(
      (item) => item.label === "input",
    )?.text;
    expect(preview).toContain("- OLD_BODY_SENTINEL");
    expect(preview).toContain("+ NEW_BODY_SENTINEL");
  });

  it.each(["edit", "write"])(
    "preserves path denies and sensitive guards for %s",
    async (toolName) => {
      const denied = harness({ "*": "allow", path: { "*": "deny" } });
      expect((await reviewToolCall({ ...read, toolName }, denied.host)).kind).toBe("denied");
      expect(denied.model).not.toHaveBeenCalled();
      expect(denied.human).not.toHaveBeenCalled();

      const guarded = harness({ "*": "allow" });
      expect(
        (await reviewToolCall({ ...read, toolName, input: { path: "/repo/.env" } }, guarded.host))
          .kind,
      ).toBe("denied");
      expect(guarded.model).not.toHaveBeenCalled();
      expect(guarded.human.mock.calls[0]?.[0].payload.review.source).toBe("guard");
    },
  );

  it("still sends Bash command bodies to the classifier", async () => {
    const h = harness({ "*": "ask" });
    const command = "printf '%s' SHELL_BODY_SENTINEL > /repo/output.txt";
    expect(
      (await reviewToolCall({ ...read, toolName: "bash", input: { command } }, h.host)).kind,
    ).toBe("allowed");
    expect(h.model.mock.calls[0]?.[3].evidence).toContainEqual({
      label: "full command",
      text: command,
      detail: null,
    });
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
