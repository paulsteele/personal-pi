import { describe, expect, it } from "vitest";
import { evaluateSafety, type GuardPathFact } from "#src/auto/safety-policy.ts";

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
function pathFact(value: string, aliases: Partial<GuardPathFact> = {}): GuardPathFact {
  return {
    value,
    matchValues: [value],
    boundaryValue: null,
    mountAliases: [],
    mountResolutionIncomplete: false,
    ...aliases,
  };
}

describe.each([true, false])("environment file guards (auto=%s)", (autoEnabled) => {
  const environment = { home: "/home/me" };

  it.each([".env.example", "/repo/nested/.env.example", "/repo/.ENV.EXAMPLE"])(
    "does not classify the template filename %s as a credential",
    (value) => {
      expect(
        evaluateSafety({ ...base, paths: [pathFact(value)] }, autoEnabled, environment),
      ).toEqual({ kind: "continue", riskMarkers: [] });
    },
  );

  it.each([
    ".env",
    ".env.local",
    ".env.production",
    ".env.examples",
    ".env.example.local",
    ".env.production.example",
    ".env.example.pem",
  ])("keeps %s sensitive", (value) => {
    expect(
      evaluateSafety({ ...base, paths: [pathFact(value)] }, autoEnabled, environment),
    ).toMatchObject({ kind: "require_human", category: "sensitive_path" });
  });

  it.each([
    ["linux", "/home/me/.ssh/.env.example"],
    ["linux", "/home/me/.aws/.env.example"],
    ["linux", "/run/secrets/.env.example"],
    ["darwin", "/home/me/.ssh/.env.example"],
    ["darwin", "/home/me/Library/Keychains/.env.example"],
  ] as const)("keeps credential directories protected on %s: %s", (platform, value) => {
    expect(
      evaluateSafety({ ...base, platform, paths: [pathFact(value)] }, autoEnabled, environment),
    ).toMatchObject({ kind: "require_human", category: "sensitive_path" });
  });

  it.each([
    { matchValues: ["/repo/.env"] },
    { boundaryValue: "/repo/.env" },
    { mountAliases: ["/run/secrets/.env.example"] },
  ])("keeps sensitive aliases protected: %j", (aliases) => {
    expect(
      evaluateSafety(
        { ...base, paths: [pathFact("/repo/.env.example", aliases)] },
        autoEnabled,
        environment,
      ),
    ).toMatchObject({ kind: "require_human", category: "sensitive_path" });
  });

  it("continues checking other paths after a template", () => {
    expect(
      evaluateSafety(
        { ...base, paths: [pathFact("/repo/.env.example"), pathFact("/repo/.env")] },
        autoEnabled,
        environment,
      ),
    ).toMatchObject({ kind: "require_human", category: "sensitive_path" });
  });
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
it("marks an unresolved path-bearing shell expansion for classifier review", () => {
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
  ).toEqual({ kind: "continue", riskMarkers: ["unresolved-path-expression"] });
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
