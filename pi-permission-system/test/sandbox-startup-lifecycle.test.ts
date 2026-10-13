import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import sandboxExtension from "../src/sandbox-extension.ts";
import { defaultToolProfile, globalToolProfilePath } from "../src/sandbox/tool-profile.ts";
import { publishPrivateText } from "../src/sandbox/storage.ts";

const resolveDefinition = vi.hoisted(() => vi.fn());
vi.mock("../src/sandbox/definition.ts", async (original) => ({
  ...(await original<typeof import("../src/sandbox/definition.ts")>()),
  resolveDefinition,
  selectDefinition: async (options: { choose(paths: string[]): Promise<unknown> }) => {
    return options.choose(["first/devcontainer.json", "second/devcontainer.json"]);
  },
}));

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("exposes the failed startup log through logs and status without requiring a ready container", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "sandbox-startup-failure-"));
  directories.push(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  await publishPrivateText(
    globalToolProfilePath(agentDir),
    JSON.stringify(defaultToolProfile()),
    undefined,
  );
  resolveDefinition.mockRejectedValueOnce(new Error("Invalid base definition"));
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  let sandboxCommand!: (args: string, ctx: unknown) => Promise<void>;
  sandboxExtension({
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) =>
      handlers.set(name, handler),
    events: { emit() {}, on: () => () => {} },
    registerTool() {},
    registerCommand: (_name: string, command: { handler: typeof sandboxCommand }) => {
      sandboxCommand = command.handler;
    },
    registerEntryRenderer() {},
  } as never);
  const notify = vi.fn();
  const ctx = {
    cwd: agentDir,
    mode: "rpc",
    hasUI: true,
    sessionManager: { getSessionId: () => "failed-session" },
    ui: { select: async () => "first/devcontainer.json", notify, setStatus: vi.fn() },
  };
  await handlers.get("session_start")!({}, ctx);
  expect(notify).toHaveBeenCalledWith("Error: Invalid base definition", "error");
  notify.mockClear();
  await sandboxCommand("logs", ctx);
  expect(notify).toHaveBeenCalledWith(
    expect.stringMatching(/Latest sandbox diagnostic log:[\s\S]*startup-logs\/.*\.jsonl/),
    "info",
  );
  expect(notify.mock.calls[0]![0]).toContain("Inspect and redact before sharing");
  notify.mockClear();
  await sandboxCommand("status", ctx);
  expect(notify).toHaveBeenCalledWith(
    expect.stringMatching(
      /Invalid base definition[\s\S]*Diagnostic log: .*startup-logs\/.*\.jsonl/,
    ),
    "info",
  );
});

it.each(["session_shutdown", "session_tree"])(
  "%s retires a pending definition selection even when its UI ignores cancellation",
  async (retirementEvent) => {
    const agentDir = await mkdtemp(join(tmpdir(), "sandbox-startup-owner-"));
    directories.push(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
    let finishSelection!: (selection: string) => void;
    const select = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishSelection = resolve;
        }),
    );
    const notify = vi.fn();
    sandboxExtension({
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) =>
        handlers.set(name, handler),
      events: { emit() {}, on: () => () => {} },
      registerTool() {},
      registerCommand() {},
      registerEntryRenderer() {},
    } as never);
    const ctx = {
      cwd: agentDir,
      mode: "rpc",
      hasUI: true,
      sessionManager: { getSessionId: () => "session" },
      ui: { select, notify, setStatus: vi.fn() },
    };
    const startup = handlers.get("session_start")!({}, ctx);
    await vi.waitFor(() => expect(select).toHaveBeenCalledOnce());
    await handlers.get(retirementEvent)!({}, ctx);
    await startup;
    expect(resolveDefinition).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    finishSelection("first/devcontainer.json");
    await Promise.resolve();
    expect(resolveDefinition).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  },
);
