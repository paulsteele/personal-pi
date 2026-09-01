import { describe, expect, it } from "vitest";
import { evaluateSafety } from "#src/auto/safety-policy.ts";

const base = {
  requestId: "r",
  toolCallId: "t",
  toolName: "bash",
  agentName: null,
  input: {},
  cwd: "/repo",
  platform: "linux" as const,
  shell: null,
  paths: [],
  riskMarkers: [],
};
it("requires human approval for a sensitive path while auto is armed", () => {
  expect(
    evaluateSafety(
      {
        ...base,
        paths: [
          {
            value: "/home/me/.ssh/id_ed25519",
            matchValues: ["/home/me/.ssh/id_ed25519"],
            boundaryValue: null,
            mountAliases: [],
            mountResolutionIncomplete: false,
          },
        ],
      },
      true,
      { home: "/home/me" },
    ).kind,
  ).toBe("require_human");
});
it("requires one-shot human approval for generic structured destructive tools", () => {
  expect(
    evaluateSafety(
      { ...base, toolName: "ticket-service", input: { arguments: { action: "delete_issue" } } },
      true,
      { home: "/home/me" },
    ).kind,
  ).toBe("require_human");
});
it("requires human approval for an unresolved path-bearing shell expansion", () => {
  expect(
    evaluateSafety(
      {
        ...base,
        shell: {
          command: 'cat "$UNKNOWN/path"',
          workdir: null,
          parseComplete: true,
          unresolvedPathExpression: true,
          commands: [],
        },
      },
      true,
      { home: "/home/me" },
    ),
  ).toMatchObject({ kind: "require_human", category: "unresolved_path_expression" });
});
it("requires one-shot human approval for a push", () => {
  expect(
    evaluateSafety(
      {
        ...base,
        shell: {
          command: "git push",
          workdir: null,
          parseComplete: true,
          commands: [
            {
              text: "git push",
              argv: ["git", "push"],
              context: null,
              wrapperKind: null,
              executedUnit: null,
            },
          ],
        },
      },
      true,
      { home: "/home/me" },
    ).kind,
  ).toBe("require_human");
});
