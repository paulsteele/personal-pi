import { expect, it, vi } from "vitest";
import { matchesKey } from "@earendil-works/pi-tui";
import { presentPermissionPrompt } from "#src/prompt/component.ts";
import { buildPermissionPromptPayload } from "#src/prompt/payload.ts";

const payload = buildPermissionPromptPayload({
  surface: "bash",
  value: "git push origin main",
  matchedPattern: "*",
  review: { source: "classifier", reason: "The remote needs operator confirmation." },
});

it("uses a compact non-overlay action panel and ignores transcript page keys", async () => {
  let rendered: string[] = [];
  let doneCalls = 0;
  const custom = vi.fn(async (factory: any, options?: unknown) => {
    expect(options).toBeUndefined();
    return await new Promise((resolve) => {
      const component = factory(
        { requestRender: vi.fn() },
        { fg: (_color: string, text: string) => text },
        {
          matches: (data: string, action: string) =>
            action === "tui.select.confirm" && matchesKey(data, "enter"),
        },
        (value: unknown) => {
          doneCalls += 1;
          resolve(value);
        },
      );
      rendered = component.render(80);
      component.handleInput("\x1b[5~"); // PageUp belongs to the fullscreen transcript.
      expect(doneCalls).toBe(0);
      component.handleInput("y");
    });
  });
  const choice = await presentPermissionPrompt(
    { mode: "tui", ui: { custom } } as never,
    "Permission Required",
    payload,
    true,
  );
  expect(choice).toBe("approve");
  expect(rendered[0]).toContain("󰀄 Human decision");
  expect(rendered.length).toBe(6);
  expect(rendered.join("\n")).not.toContain("git push");
});
