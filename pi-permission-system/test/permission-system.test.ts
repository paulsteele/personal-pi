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
  mode?: "rpc" | "tui";
  signal?: AbortSignal;
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
  const entries: Array<{ customType: string; data: unknown }> = [];
  const entryRenderers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    events,
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ customType, data })),
    registerEntryRenderer: vi.fn((customType: string, renderer: (...args: any[]) => unknown) =>
      entryRenderers.set(customType, renderer),
    ),
  };
  const ctx = {
    cwd: "/repo",
    hasUI: true,
    mode: options?.mode ?? "rpc",
    signal: options?.signal,
    sessionManager: { getBranch: () => options?.branch ?? [], appendCustomEntry: vi.fn() },
    ui: {
      setStatus: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      notify: vi.fn(),
      custom: vi.fn(),
    },
    modelRegistry: {
      getAvailable: () => [],
      find: () =>
        options?.modelReply ? ({ provider: "test", id: "reviewer" } as never) : undefined,
      hasConfiguredAuth: () => Boolean(options?.modelReply),
      complete: vi.fn(async () => options?.modelReply as never),
    },
  };
  permissionSystem(pi as never);
  return { agentDir, previous, handlers, events, ctx, pi, entries, entryRenderers };
}

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("integrated permission system", () => {
  it("publishes only the compact armed auto-mode footer label", async () => {
    const h = setup({ enabledByDefault: true });
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("auto-mode", "⏵⏵ auto");
    rmSync(h.agentDir, { recursive: true, force: true });
  });

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

  it("allows an approved external directory for the rest of the session only", async () => {
    const h = setup({
      enabledByDefault: false,
      permission: { "*": "ask", read: "allow", external_directory: "ask" },
    });
    h.ctx.ui.select.mockResolvedValueOnce("p allow directory for session");
    const directory = join(h.agentDir, "outside/project");
    const file = join(directory, "a.ts");
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, "export {};\n");
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);

    const first = await h.handlers.get("tool_call")?.(
      { toolName: "read", toolCallId: "outside-1", input: { path: file } },
      h.ctx,
    );
    expect(first).toEqual({});
    expect(h.ctx.ui.select.mock.calls[0]?.[1]).toEqual([
      "y approve once",
      "p allow directory for session",
      "n deny",
    ]);
    const allowedDirectory = h.ctx.ui.notify.mock.calls[0]?.[0]?.replace(
      "Allowed external directory for this session: ",
      "",
    );
    expect(allowedDirectory).toMatch(/\/outside\/project$/);
    expect(h.ctx.ui.notify.mock.calls[0]?.[1]).toBe("info");
    const persisted = JSON.parse(
      readFileSync(join(h.agentDir, "extensions/pi-permission-system/config.json"), "utf8"),
    );
    expect(persisted.permission.external_directory).toBe("ask");

    const second = await h.handlers.get("tool_call")?.(
      { toolName: "read", toolCallId: "outside-2", input: { path: file } },
      h.ctx,
    );
    expect(second).toEqual({});
    expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);

    h.ctx.ui.select.mockResolvedValueOnce("n deny");
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const nextSession = await h.handlers.get("tool_call")?.(
      { toolName: "read", toolCallId: "outside-3", input: { path: file } },
      h.ctx,
    );
    expect(nextSession).toMatchObject({ block: true });
    expect(h.ctx.ui.select).toHaveBeenCalledTimes(2);
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("colors deterministic Bash policy allows separately from unresolved units in review prompts", async () => {
    const h = setup({
      mode: "tui",
      permission: { "*": "ask", bash: { "git status": "allow" } },
    });
    h.ctx.ui.custom.mockResolvedValueOnce("approve");
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "bash-mixed-review",
        input: { command: "git status && echo needs-review" },
      },
      h.ctx,
    );
    expect(result).toEqual({});
    const request = h.entries[0]?.data as {
      payload: { evidence: Array<{ text: string; color?: string }> };
    };
    expect(request.payload.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "git status", color: "policy_allow" }),
        expect.objectContaining({ text: "echo needs-review", color: "warning" }),
      ]),
    );
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("keeps an already-confirmed note decision authoritative when note input is blank", async () => {
    const h = setup();
    h.ctx.ui.select.mockResolvedValueOnce("a approve + classifier note");
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

  it("commits an unavailable-classifier human fallback with one selection", async () => {
    const h = setup({ enabledByDefault: true });
    h.ctx.ui.select.mockResolvedValueOnce("y approve once");
    const autoEvents: any[] = [];
    h.events.on("auto-mode:decision", (event) => autoEvents.push(event));
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      { toolName: "write", toolCallId: "write-once", input: { path: "/repo/a.ts" } },
      h.ctx,
    );
    expect(result).toEqual({});
    expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(h.ctx.ui.select.mock.calls[0]?.[0]).toContain("classifier model is unavailable");
    expect(autoEvents.at(-1)).toMatchObject({
      verdict: "require_human",
      cause: "model-unavailable",
    });
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("persists bounded request and outcome transcript entries for TUI human review", async () => {
    const h = setup({ enabledByDefault: false, mode: "tui" });
    h.ctx.ui.custom = vi.fn(async () => "approve");
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      { toolName: "write", toolCallId: "write-entry", input: { path: "/repo/a.ts" } },
      h.ctx,
    );
    expect(result).toEqual({});
    expect(h.entries.map((entry) => entry.customType)).toEqual([
      "pi-permission-system:permission-request:v1",
      "pi-permission-system:permission-outcome:v1",
    ]);
    expect(h.entries[0]?.data).toMatchObject({
      requestId: "perm-write-entry",
      toolCallId: "write-entry",
      payload: { review: { source: "policy" } },
    });
    expect(JSON.stringify(h.entries)).not.toContain("classifier note");
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("routes classifier deny to human approval and shows its reason", async () => {
    const h = setup({
      modelReply: {
        content: [
          {
            type: "toolCall",
            name: "submit_verdict",
            arguments: { verdict: "deny", reason: "The remote is outside the stated scope." },
          },
        ],
      },
    });
    h.ctx.ui.select.mockResolvedValueOnce("y approve once");
    const autoEvents: any[] = [];
    h.events.on("auto-mode:decision", (event) => autoEvents.push(event));
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      { toolName: "write", toolCallId: "write-review", input: { path: "/repo/a.ts" } },
      h.ctx,
    );
    expect(result).toEqual({});
    expect(h.ctx.ui.select.mock.calls[0]?.[0]).toContain("The remote is outside the stated scope.");
    expect(h.ctx.ui.select.mock.calls[0]?.[1]).toEqual([
      "y approve once",
      "a approve + classifier note",
      "n deny",
      "d deny + classifier note",
    ]);
    expect(autoEvents.at(-1)).toMatchObject({ verdict: "require_human", cause: "classifier" });
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("routes classifier review for explicit skills through human authority", async () => {
    const h = setup({
      modelReply: {
        content: [
          {
            type: "toolCall",
            name: "submit_verdict",
            arguments: { verdict: "require_human", reason: "Skill scope needs confirmation." },
          },
        ],
      },
    });
    h.ctx.ui.select.mockResolvedValueOnce("n deny");
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("input")?.(
      { text: "/skill:release publish", source: "interactive" },
      h.ctx,
    );
    expect(result).toEqual({ action: "handled" });
    expect(h.ctx.ui.select.mock.calls[0]?.[0]).toContain("Skill scope needs confirmation.");
    expect(h.ctx.ui.select.mock.calls[0]?.[1]).toHaveLength(4);
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("does not prompt after external classifier cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = setup({
      signal: controller.signal,
      modelReply: {
        content: [{ type: "toolCall", name: "submit_verdict", arguments: { verdict: "allow" } }],
      },
    });
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      { toolName: "write", toolCallId: "write-cancelled", input: { path: "/repo/a.ts" } },
      h.ctx,
    );
    expect(result).toMatchObject({ block: true, reason: "Permission review cancelled." });
    expect(h.ctx.ui.select).not.toHaveBeenCalled();
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("routes an armed sensitive-path guard to human approval without classifier notes", async () => {
    const home = process.env.HOME ?? "/Users/test";
    const h = setup({ enabledByDefault: true });
    h.ctx.ui.select.mockResolvedValueOnce("y approve once");
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      {
        toolName: "read",
        toolCallId: "guard-human",
        input: { path: `${home}/.ssh/id_ed25519` },
      },
      h.ctx,
    );
    expect(result).toEqual({});
    const [title, labels] = h.ctx.ui.select.mock.calls[0] ?? [];
    expect(title).toContain("Security check");
    expect(labels).toEqual(["y approve once", "n deny"]);
    expect(h.ctx.modelRegistry.complete).not.toHaveBeenCalled();
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

  it("routes an unresolved shell path through the classifier even when Bash policy allows it", async () => {
    const h = setup({
      enabledByDefault: true,
      permission: { "*": "allow", bash: "allow" },
      modelReply: {
        content: [{ type: "toolCall", name: "submit_verdict", arguments: { verdict: "allow" } }],
      },
      branch: [
        { type: "message", message: { role: "user", content: "read the configured report" } },
      ],
    });
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "unresolved-classified",
        input: { command: 'cat "$UNKNOWN/report.txt"' },
      },
      h.ctx,
    );
    expect(result).toEqual({});
    expect(h.ctx.modelRegistry.complete).toHaveBeenCalledOnce();
    const modelCalls = h.ctx.modelRegistry.complete.mock.calls as unknown as Array<
      [unknown, { messages?: Array<{ content?: string }> }]
    >;
    const request = modelCalls[0]?.[1];
    expect(request.messages?.[0]?.content).toContain("risk marker: unresolved-path-expression");
    expect(h.ctx.ui.select).not.toHaveBeenCalled();
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("asks the human about an unresolved shell path when auto mode is off", async () => {
    const h = setup({ enabledByDefault: false, permission: { "*": "allow", bash: "allow" } });
    h.ctx.ui.select.mockResolvedValueOnce("n deny");
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "unresolved-manual",
        input: { command: 'cat "$UNKNOWN/report.txt"' },
      },
      h.ctx,
    );
    expect(result).toMatchObject({ block: true });
    expect(h.ctx.ui.select.mock.calls[0]?.[0]).toContain(
      "A filesystem path contains a shell expansion that could not",
    );
    expect(h.ctx.modelRegistry.complete).not.toHaveBeenCalled();
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("routes the exact Bash loop through the sensitive-path guard without classification", async () => {
    const h = setup({
      enabledByDefault: true,
      modelReply: {
        content: [{ type: "toolCall", name: "submit_verdict", arguments: { verdict: "allow" } }],
      },
      branch: [{ type: "message", message: { role: "user", content: "yes read my public keys" } }],
    });
    h.ctx.ui.select.mockResolvedValueOnce("y approve once");
    const autoEvents: any[] = [];
    h.events.on("auto-mode:decision", (event) => autoEvents.push(event));
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "loop-sensitive",
        input: { command: 'for key in "$HOME"/.ssh/*.pub; do cat "$key"; done' },
      },
      h.ctx,
    );
    expect(result).toEqual({});
    expect(h.ctx.ui.select.mock.calls[0]?.[0]).toContain("Security check");
    expect(h.ctx.modelRegistry.complete).not.toHaveBeenCalled();
    expect(autoEvents.at(-1)).toMatchObject({
      mechanism: "guard",
      category: "sensitive_path",
      verdict: "require_human",
    });
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("blocks the exact Bash loop headlessly before classification", async () => {
    const h = setup({
      enabledByDefault: true,
      modelReply: {
        content: [{ type: "toolCall", name: "submit_verdict", arguments: { verdict: "allow" } }],
      },
    });
    h.ctx.hasUI = false;
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "headless-loop-sensitive",
        input: { command: 'for key in "$HOME"/.ssh/*.pub; do cat "$key"; done' },
      },
      h.ctx,
    );
    expect(result).toMatchObject({ block: true });
    expect(h.ctx.modelRegistry.complete).not.toHaveBeenCalled();
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("enforces deterministic command guards hidden in compound syntax", async () => {
    const h = setup({ enabledByDefault: true });
    h.ctx.ui.select.mockResolvedValueOnce("n deny");
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "compound-push",
        input: { command: "if true; then git push; fi" },
      },
      h.ctx,
    );
    expect(result).toMatchObject({ block: true });
    expect(h.ctx.ui.select.mock.calls[0]?.[0]).toContain("Security check");
    expect(h.ctx.modelRegistry.complete).not.toHaveBeenCalled();
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("keeps an inner Bash policy deny terminal inside a compound command", async () => {
    const h = setup({
      enabledByDefault: true,
      permission: { "*": "allow", bash: { "*": "allow", "git push": "deny" } },
    });
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "compound-policy-deny",
        input: { command: "if true; then git push; fi" },
      },
      h.ctx,
    );
    expect(result).toMatchObject({ block: true, reason: "Denied by permission policy." });
    expect(h.ctx.ui.select).not.toHaveBeenCalled();
    expect(h.ctx.modelRegistry.complete).not.toHaveBeenCalled();
    rmSync(h.agentDir, { recursive: true, force: true });
  });

  it("fails closed for a headless sensitive-path escalation", async () => {
    const home = process.env.HOME ?? "/Users/test";
    const h = setup({ enabledByDefault: true });
    h.ctx.hasUI = false;
    await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
    const result = await h.handlers.get("tool_call")?.(
      {
        toolName: "read",
        toolCallId: "headless-guard",
        input: { path: `${home}/.ssh/id_ed25519` },
      },
      h.ctx,
    );
    expect(result).toMatchObject({ block: true });
    expect(h.ctx.modelRegistry.complete).not.toHaveBeenCalled();
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
