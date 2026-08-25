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
      commandUnits: [{ text: "cd app" }, { text: "git push origin main", context: "subshell" }],
    });
    const rendered = renderPermissionPrompt(payload, 100, theme, false).lines.join("\n");
    expect(rendered).toContain("tool              : bash");
    expect(rendered).toContain("rule              : *");
    expect(rendered).toContain("command           : <warning>git push origin main</warning>");
    expect(rendered).toContain(
      "full command      : <warning>cd app && git push origin main</warning>",
    );
    expect(rendered).toContain("working directory : /repo");
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
