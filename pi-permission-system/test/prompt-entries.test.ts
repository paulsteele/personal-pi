import { describe, expect, it, vi } from "vitest";
import {
  appendPermissionOutcome,
  appendPermissionRequest,
  PERMISSION_OUTCOME_ENTRY,
  PERMISSION_REQUEST_ENTRY,
  registerPermissionEntryRenderers,
} from "#src/prompt/entries.ts";
import { buildPermissionPromptPayload } from "#src/prompt/payload.ts";

const theme = {
  fg(_color: string, text: string): string {
    return text;
  },
};

describe("durable permission transcript entries", () => {
  it("bounds persisted request facts and never stores note text", () => {
    const appendEntry = vi.fn();
    const payload = buildPermissionPromptPayload({
      surface: "bash",
      value: "x".repeat(3_000),
      matchedPattern: "*",
      review: { source: "classifier", reason: "review ".repeat(200), cause: "classifier" },
    });
    appendPermissionRequest({ appendEntry } as never, "r".repeat(200), "tool", payload);
    appendPermissionOutcome({ appendEntry } as never, "r1", "tool", "approve_note");
    expect(appendEntry.mock.calls[0]?.[0]).toBe(PERMISSION_REQUEST_ENTRY);
    expect(appendEntry.mock.calls[0]?.[1]).toMatchObject({
      version: 1,
      toolCallId: "tool",
      payload: { review: { source: "classifier" } },
    });
    expect((appendEntry.mock.calls[0]?.[1] as any).payload.value.length).toBe(2_000);
    expect((appendEntry.mock.calls[0]?.[1] as any).payload.review.reason.length).toBe(500);
    expect(appendEntry.mock.calls[1]?.[0]).toBe(PERMISSION_OUTCOME_ENTRY);
    expect(appendEntry.mock.calls[1]?.[1]).toMatchObject({ allowed: true });
    expect(JSON.stringify(appendEntry.mock.calls)).not.toContain("classifier note");
  });

  it("registers expandable request and compact outcome renderers", () => {
    const renderers = new Map<string, (...args: any[]) => any>();
    registerPermissionEntryRenderers({
      registerEntryRenderer: (type: string, renderer: (...args: any[]) => any) =>
        renderers.set(type, renderer),
    } as never);
    const payload = buildPermissionPromptPayload({
      surface: "bash",
      value: "git push origin main",
      matchedPattern: "*",
      review: { source: "classifier", reason: "Remote approval is required." },
    });
    const request = renderers.get(PERMISSION_REQUEST_ENTRY)?.(
      { data: { version: 1, requestId: "r1", toolCallId: "t1", payload } },
      { expanded: false },
      theme,
    );
    const lines = request.render(80).join("\n");
    expect(lines).toContain("󰚩 ? → 󰀄");
    expect(lines).toContain("Remote approval is required.");
    const outcome = renderers.get(PERMISSION_OUTCOME_ENTRY)?.(
      { data: { version: 1, requestId: "r1", toolCallId: "t1", allowed: false } },
      { expanded: false },
      theme,
    );
    expect(outcome.render(80).join("\n")).toContain("󰀄 ✕ denied");
  });
});
