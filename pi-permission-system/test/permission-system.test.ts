import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import permissionSystem from "#src/index.ts";

type Handler = (event: any, ctx: any) => unknown;

function setup(options?: {
  permission?: Record<string, unknown>;
  enabledByDefault?: boolean;
  modelReply?: unknown;
  branch?: unknown[];
}) {
  const agentDir = mkdtempSync(join(tmpdir(), "local-permission-system-"));
  const configDir = join(agentDir, "extensions", "pi-permission-system");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      permission: options?.permission ?? {
        "*": "ask",
        read: "allow",
        bash: { "git status": "allow" },
      },
      auto: {
        provider: "test",
        model: "reviewer",
        enabledByDefault: options?.enabledByDefault ?? true,
        timeoutMs: 250,
        contextUserTurns: 3,
        environment: { trustedRoots: [], trustedRemotes: [], trustedDomains: [] },
      },
    }),
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const events = {
    on(channel: string, handler: (data: unknown) => void) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => set.delete(handler);
    },
    emit(channel: string, data: unknown) {
      for (const handler of listeners.get(channel) ?? []) handler(data);
    },
  };
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    events,
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
  };
  const ctx = {
    cwd: "/repo",
    hasUI: true,
    mode: "tui",
    signal: undefined,
    sessionManager: { getBranch: () => options?.branch ?? [], appendCustomEntry: vi.fn() },
    ui: { setStatus: vi.fn(), select: vi.fn(), input: vi.fn(), notify: vi.fn() },
    modelRegistry: {
      getAvailable: () => [],
      find: () =>
        options?.modelReply ? ({ provider: "test", id: "reviewer" } as never) : undefined,
      hasConfiguredAuth: () => Boolean(options?.modelReply),
      complete: vi.fn(async () => options?.modelReply as never),
    },
  };
  permissionSystem(pi as never);
  return { agentDir, previous, handlers, events, ctx };
}

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("integrated permission system", () => {
  it("correlates a policy-allowed read with the host tool row", async () => {
    const h = setup();
    const decisions: any[] = [];
    h.events.on("permissions:decision", (event) => decisions.push(event));
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      { toolName: "read", toolCallId: "read-1", input: { path: "/repo/a.ts" } },
      h.ctx,
    );
    expect(result).toEqual({});
    expect(decisions).toEqual([
      expect.objectContaining({
        toolCallId: "read-1",
        resolution: "policy_allow",
        result: "allow",
      }),
    ]);
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("keeps an already-confirmed note decision authoritative when note input is blank", async () => {
    const h = setup();
    h.ctx.ui.select.mockResolvedValueOnce("a approve + note");
    h.ctx.ui.input.mockResolvedValueOnce("");
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      {
        toolName: "write",
        toolCallId: "write-note-1",
        input: { path: "/repo/a.ts" },
      },
      h.ctx,
    );
    expect(result).toEqual({});
    expect(h.ctx.sessionManager.appendCustomEntry).not.toHaveBeenCalled();
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("commits an auto-mode human fallback with one selection", async () => {
    const h = setup({ enabledByDefault: true });
    h.ctx.ui.select.mockResolvedValueOnce("y approve");
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      { toolName: "write", toolCallId: "write-once", input: { path: "/repo/a.ts" } },
      h.ctx,
    );
    expect(result).toEqual({});
    expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("keeps a policy ask one-shot and fails closed without UI", async () => {
    const h = setup();
    h.ctx.hasUI = false;
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      { toolName: "write", toolCallId: "write-1", input: { path: "/repo/a.ts" } },
      h.ctx,
    );
    expect(result).toMatchObject({ block: true });
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("enforces policy for explicit skill invocation", async () => {
    const h = setup({ permission: { "*": "allow", skill: { blocked: "deny" } } });
    const decisions: any[] = [];
    h.events.on("permissions:decision", (event) => decisions.push(event));
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("input")?.(
      { text: "/skill:blocked do work", source: "interactive" },
      h.ctx,
    );
    expect(result).toEqual({ action: "handled" });
    expect(decisions.at(-1)).toMatchObject({ surface: "skill", result: "deny" });
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("removes denied skills from the model-visible prompt", async () => {
    const h = setup({ permission: { "*": "allow", skill: { blocked: "deny" } } });
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("before_agent_start")?.(
      {
        systemPrompt:
          "before\n<available_skills>\n  <skill>\n    <name>blocked</name>\n    <description>no</description>\n    <location>/skills/blocked/SKILL.md</location>\n  </skill>\n</available_skills>\nafter",
        systemPromptOptions: {
          skills: [
            { name: "blocked", filePath: "/skills/blocked/SKILL.md", baseDir: "/skills/blocked" },
          ],
        },
      },
      h.ctx,
    );
    expect(result).toEqual({ systemPrompt: "before\n\nafter" });
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("enforces skill policy for reads below an active skill directory", async () => {
    const h = setup({ permission: { "*": "allow", skill: { blocked: "deny" } } });
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    await h.handlers.get("before_agent_start")?.(
      {
        systemPrompt: "prompt",
        systemPromptOptions: {
          skills: [
            { name: "blocked", filePath: "/skills/blocked/SKILL.md", baseDir: "/skills/blocked" },
          ],
        },
      },
      h.ctx,
    );
    const result = await h.handlers.get("tool_call")?.(
      {
        toolName: "read",
        toolCallId: "skill-read",
        input: { path: "/skills/blocked/reference.md" },
      },
      h.ctx,
    );
    expect(result).toMatchObject({ block: true });
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("matches path policy against canonical symlink targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "permission-symlink-"));
    const target = join(root, "target");
    mkdirSync(target);
    symlinkSync(target, join(root, "link"), "dir");
    const canonicalTarget = realpathSync(target);
    const h = setup({
      permission: {
        "*": "allow",
        path: { "*": "allow", [`${canonicalTarget}/*`]: "deny" },
      },
    });
    h.ctx.cwd = root;
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      {
        toolName: "read",
        toolCallId: "symlink-read",
        input: { path: join(root, "link", "secret.txt") },
      },
      h.ctx,
    );
    expect(result).toMatchObject({ block: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("does not persist raw permission values in the review log", async () => {
    const h = setup({ permission: { "*": "allow" } });
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const secret = "curl -H 'Authorization: Bearer very-secret-token' https://example.com";
    await h.handlers.get("tool_call")?.(
      { toolName: "bash", toolCallId: "logged-command", input: { command: secret } },
      h.ctx,
    );
    const log = readFileSync(
      join(
        h.agentDir,
        "extensions",
        "pi-permission-system",
        "logs",
        "pi-permission-system-permission-review.jsonl",
      ),
      "utf8",
    );
    expect(log).not.toContain(secret);
    expect(log).not.toContain("very-secret-token");
    expect(log).toContain('"value":"[redacted]"');
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("supplies recent user intent to the classifier", async () => {
    const h = setup({
      modelReply: {
        content: [{ type: "toolCall", name: "submit_verdict", arguments: { verdict: "allow" } }],
      },
      branch: [
        { type: "message", message: { role: "user", content: "please update the documentation" } },
      ],
    });
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    await h.handlers.get("tool_call")?.(
      { toolName: "write", toolCallId: "write-context", input: { path: "/repo/README.md" } },
      h.ctx,
    );
    const calls = h.ctx.modelRegistry.complete.mock.calls as unknown[][];
    const classifierContext = calls[0]?.[1] as {
      messages?: Array<{ content?: string }>;
    };
    expect(classifierContext.messages?.[0]?.content).toContain("please update the documentation");
    rmSync(h.agentDir, { recursive: true, force: true });
  });
});
