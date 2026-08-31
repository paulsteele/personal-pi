import { describe, expect, it } from "vitest";
import { buildPermissionPromptPayload } from "#src/prompt/payload.ts";
import { renderPermissionPrompt } from "#src/prompt/renderer.ts";

const theme = {
  fg(color: string, text: string): string {
    return `<${color}>${text}</${color}>`;
  },
};

describe("rich permission prompt", () => {
  it("renders aligned policy, command, cwd, and command-unit facts", () => {
    const payload = buildPermissionPromptPayload({
      surface: "bash",
      value: "git push origin main",
      matchedPattern: "*",
      toolName: "bash",
      command: "cd app && git push origin main",
      cwd: "/repo",
      commandUnits: [
        { text: "cd app", policyState: "allow" },
        { text: "git push origin main", context: "subshell", policyState: "ask" },
      ],
    });
    const rendered = renderPermissionPrompt(payload, 100, theme, false).lines.join("\n");
    expect(rendered).toContain("tool              : bash");
    expect(rendered).toContain("rule              : *");
    expect(rendered).toContain("command           : <warning>git push origin main</warning>");
    expect(rendered).toContain(
      "full command      : <warning>cd app && git push origin main</warning>",
    );
    expect(rendered).toContain("command unit      : <thinkingLow>cd app</thinkingLow>");
    expect(rendered).toContain("context           : subshell");
    expect(rendered).toContain("working directory : /repo");
  });

  it("renders classifier reasoning with robot provenance", () => {
    const payload = buildPermissionPromptPayload({
      surface: "bash",
      value: "curl https://unknown.example",
      matchedPattern: "*",
      review: {
        source: "classifier",
        reason: "The destination is not established by the user's request.",
        cause: "classifier",
      },
    });
    const rendered = renderPermissionPrompt(payload, 100, theme, false).lines.join("\n");
    expect(rendered).toContain("󰚩 Classifier review");
    expect(rendered).toContain("Human approval requested");
    expect(rendered).toContain("The destination is not established by the user's request.");
  });

  it("renders deterministic safety reasoning with security provenance", () => {
    const payload = buildPermissionPromptPayload({
      surface: "path",
      value: "~/.ssh/id_ed25519",
      matchedPattern: "*",
      review: {
        source: "guard",
        category: "sensitive_path",
        reason: "Access to a protected credential requires fresh human approval.",
      },
    });
    const rendered = renderPermissionPrompt(payload, 100, theme, false).lines.join("\n");
    expect(rendered).toContain("󰒃 Security check");
    expect(rendered).toContain("sensitive_path");
    expect(rendered).toContain("protected credential");
  });

  it("shows resolved path aliases and marks truncated prompts expandable", () => {
    const payload = buildPermissionPromptPayload({
      surface: "external_directory",
      value: "../outside/secret.key",
      matchedPattern: "*",
      toolName: "read",
      paths: [{ value: "../outside/secret.key", resolved: "/outside/secret.key" }],
      inputPreview: "x".repeat(1_000),
    });
    const collapsed = renderPermissionPrompt(payload, 80, theme, false);
    const expanded = renderPermissionPrompt(payload, 80, theme, true);
    expect(collapsed.lines.join("\n")).toContain(
      "<warning>../outside/secret.key → /outside/secret.key</warning>",
    );
    expect(collapsed.elided).toBe(true);
    expect(expanded.lines.length).toBeGreaterThan(collapsed.lines.length);
  });
});
