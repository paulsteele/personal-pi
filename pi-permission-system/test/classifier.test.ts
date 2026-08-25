import { describe, expect, it, vi } from "vitest";
import type { Config } from "#src/config.ts";
import { buildPrompt, classify } from "#src/auto/classifier.ts";

const auto = {
  provider: "test",
  model: "reviewer",
  enabledByDefault: true,
  timeoutMs: 1_000,
  contextUserTurns: 3,
  environment: { trustedRoots: [], trustedRemotes: [], trustedDomains: [] },
} satisfies Config["auto"];
const facts = {
  surface: "bash",
  toolName: "bash",
  invokedToolName: null,
  value: "npm test",
  matchedPattern: "*",
  commandContext: null,
  executedUnit: null,
  agentName: null,
  evidence: [],
};

it("renders configured environment hints and risk markers", () => {
  const prompt = buildPrompt(
    facts,
    {
      cwd: "/repo",
      gitRemotes: ["origin git@example/repo"],
      recentUserTurns: ["run the tests"],
      trustedRoots: ["/repo"],
      trustedRemotes: ["git@example/repo"],
      trustedDomains: ["example.com"],
      riskMarkers: ["shell-parse-incomplete"],
    },
    auto,
  );
  expect(prompt).toContain("git remote: origin git@example/repo");
  expect(prompt).toContain("trusted root hint: /repo");
  expect(prompt).toContain("trusted remote hint: git@example/repo");
  expect(prompt).toContain("trusted domain hint: example.com");
  expect(prompt).toContain("risk marker: shell-parse-incomplete");
  expect(prompt).toContain("user: run the tests");
});

it("propagates cancellation to the classifier request", async () => {
  const caller = {
    complete: vi.fn(
      (_model, _context, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    ),
  };
  const controller = new AbortController();
  const pending = classify({
    caller: caller as never,
    model: {} as never,
    facts,
    context: { cwd: "/repo", gitRemotes: [], recentUserTurns: [] },
    config: auto,
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).resolves.toMatchObject({
    verdict: { kind: "defer" },
    deferReason: "call-failed",
  });
});
