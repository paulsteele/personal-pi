import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { discoverSettingsSections } from "@paulsteele/pi-shared-ui";
import { afterEach, expect, it, vi } from "vitest";
import sandboxExtension from "../src/sandbox-extension.ts";
import { reviewHostAction, reviewSandboxToolCall } from "../src/sandbox/gate.ts";
import { resolveSandboxMode, SANDBOX_MODE_ENTRY } from "../src/sandbox/mode.ts";
import { parseSandboxSettings, saveSandboxSettings } from "../src/sandbox/settings.ts";
import { registerSandboxTools } from "../src/sandbox/tools.ts";
import { SANDBOX_STATE_CHANNEL } from "../src/sandbox/events.ts";
import { defaultToolProfile, globalToolProfilePath } from "../src/sandbox/tool-profile.ts";
import { publishPrivateText } from "../src/sandbox/storage.ts";

const resolveDefinition = vi.hoisted(() => vi.fn());
vi.mock("../src/sandbox/definition.ts", async (original) => ({
  ...(await original<typeof import("../src/sandbox/definition.ts")>()),
  resolveDefinition,
  selectDefinition: async () => ({ path: "/never/devcontainer.json" }),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

const modeEntry = (off: boolean) => ({
  type: "custom",
  customType: SANDBOX_MODE_ENTRY,
  data: { off },
});

it.each([
  { scenario: "a new session", branch: [], flag: false, env: {}, expected: "sandboxed" },
  { scenario: "the --no-sandbox flag", branch: [], flag: true, env: {}, expected: "host" },
  {
    scenario: "PI_SANDBOX=off",
    branch: [],
    flag: false,
    env: { PI_SANDBOX: "off" },
    expected: "host",
  },
  {
    scenario: "a recorded /sandbox off",
    branch: [modeEntry(true)],
    flag: false,
    env: {},
    expected: "host",
  },
  {
    scenario: "a later /sandbox on",
    branch: [modeEntry(true), modeEntry(false)],
    flag: false,
    env: {},
    expected: "sandboxed",
  },
  {
    scenario: "the launch flag despite a recorded /sandbox on",
    branch: [modeEntry(false)],
    flag: true,
    env: {},
    expected: "host",
  },
])("resolves the sandbox mode for $scenario", ({ branch, flag, env, expected }) => {
  expect(resolveSandboxMode({ branch, noSandboxFlag: flag, environment: env })).toBe(expected);
});

async function extensionFixture(options: { noSandboxFlag?: boolean } = {}) {
  const agentDir = await temporaryDirectory("sandbox-off-agent-");
  const cwd = await temporaryDirectory("sandbox-off-project-");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  await publishPrivateText(
    globalToolProfilePath(agentDir),
    JSON.stringify(defaultToolProfile()),
    undefined,
  );
  const events = createEventBus();
  const published: { phase: string }[] = [];
  events.on(SANDBOX_STATE_CHANNEL, (state) => published.push(state as { phase: string }));
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const entries: unknown[] = [];
  let sandboxCommand!: (args: string, ctx: unknown) => Promise<void>;
  sandboxExtension({
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) =>
      handlers.set(name, handler),
    events,
    registerTool() {},
    registerFlag() {},
    getFlag: () => options.noSandboxFlag === true,
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    registerCommand: (_name: string, command: { handler: typeof sandboxCommand }) => {
      sandboxCommand = command.handler;
    },
    registerEntryRenderer() {},
  } as never);
  const notify = vi.fn();
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: true,
    sessionManager: { getSessionId: () => "session", getBranch: () => entries },
    waitForIdle: vi.fn(async () => {}),
    ui: { select: vi.fn(), notify, setStatus: vi.fn() },
  };
  return { agentDir, cwd, events, published, handlers, entries, notify, ctx, sandboxCommand };
}

it("a --no-sandbox launch never resolves a devcontainer and publishes the off state", async () => {
  const fixture = await extensionFixture({ noSandboxFlag: true });
  await fixture.handlers.get("session_start")!({}, fixture.ctx);
  expect(resolveDefinition).not.toHaveBeenCalled();
  expect(fixture.published.at(-1)?.phase).toBe("off");
  await fixture.sandboxCommand("status", fixture.ctx);
  expect(fixture.notify).toHaveBeenLastCalledWith(
    expect.stringContaining("Sandbox OFF (host passthrough)"),
    "info",
  );
});

it("/sandbox off records the session choice, and /sandbox on restarts the devcontainer", async () => {
  const fixture = await extensionFixture();
  resolveDefinition.mockRejectedValue(new Error("Podman is wedged"));
  await fixture.handlers.get("session_start")!({}, fixture.ctx);
  expect(resolveDefinition).toHaveBeenCalledTimes(1);

  await fixture.sandboxCommand("off", fixture.ctx);

  expect(fixture.entries).toEqual([modeEntry(true)]);
  expect(fixture.published.at(-1)?.phase).toBe("off");
  expect(fixture.ctx.waitForIdle).not.toHaveBeenCalled();
  expect(fixture.notify).toHaveBeenLastCalledWith(
    expect.stringContaining("Sandbox is OFF for this session"),
    "warning",
  );
  await fixture.sandboxCommand("rebuild", fixture.ctx);
  expect(fixture.notify).toHaveBeenLastCalledWith(
    expect.stringContaining("Run /sandbox on first"),
    "warning",
  );

  await fixture.handlers.get("session_start")!({}, fixture.ctx);
  expect(resolveDefinition).toHaveBeenCalledTimes(1);

  await fixture.sandboxCommand("on", fixture.ctx);
  expect(fixture.entries).toEqual([modeEntry(true), modeEntry(false)]);
  expect(resolveDefinition).toHaveBeenCalledTimes(2);
});

it("replaces the sandbox system prompt with a host-passthrough notice while off", async () => {
  const fixture = await extensionFixture({ noSandboxFlag: true });
  await fixture.handlers.get("session_start")!({}, fixture.ctx);
  const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
  await fixture.handlers.get("before_agent_start")!(event, fixture.ctx);
  expect(event.systemPromptOptions.sections.sandbox).toContain("Sandbox is OFF for this session");
  expect(event.systemPromptOptions.sections.sandbox).toContain(fixture.cwd);
});

it("the General Settings action toggles the session sandbox mode in both directions", async () => {
  const fixture = await extensionFixture();
  resolveDefinition.mockRejectedValue(new Error("Podman is wedged"));
  await fixture.handlers.get("session_start")!({}, fixture.ctx);
  const general = () =>
    discoverSettingsSections({ events: fixture.events }).find(
      (section) => section.id === "sandbox",
    )!;
  const toggle = () => general().actions!.find((action) => action.id === "toggle-mode")!;
  expect(toggle().label).toBe("Turn sandbox off for this session");

  await toggle().run(fixture.ctx as never, new AbortController().signal);
  expect(fixture.published.at(-1)?.phase).toBe("off");
  expect(toggle().label).toBe("Turn sandbox back on");

  await toggle().run(fixture.ctx as never, new AbortController().signal);
  expect(fixture.entries).toEqual([modeEntry(true), modeEntry(false)]);
  expect(toggle().label).toBe("Turn sandbox off for this session");
});

it("dispatches built-in tools to the host implementation only while the sandbox is off", async () => {
  const cwd = await temporaryDirectory("sandbox-off-tools-");
  await writeFile(join(cwd, "notes.txt"), "host content");
  const definitions = new Map<string, any>();
  let userBash!: () => unknown;
  let hostMode = false;
  const guestRead = vi.fn(async () => Buffer.from("guest content"));
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    registerSandboxTools(
      {
        registerTool(tool: { name: string }) {
          definitions.set(tool.name, tool);
        },
        on(event: string, handler: () => unknown) {
          if (event === "user_bash") {
            userBash = handler;
          }
        },
      } as never,
      () =>
        ({
          filesystem: {
            read: guestRead,
            access: async () => {},
            mime: async () => null,
          },
        }) as never,
      () => hostMode,
    );
  } finally {
    process.chdir(originalCwd);
  }
  const signal = new AbortController().signal;
  const readNotes = async () =>
    (await definitions.get("read").execute("read", { path: "notes.txt" }, signal, undefined, {}))
      .content[0].text;

  expect(await readNotes()).toContain("guest content");
  expect(userBash()).toBeDefined();

  hostMode = true;
  expect(await readNotes()).toContain("host content");
  expect(userBash()).toBeUndefined();
  expect(guestRead).toHaveBeenCalledTimes(1);
});

async function hostGateFixture(permissionForCwd: (cwd: string) => Record<string, unknown>) {
  const agentDir = await temporaryDirectory("sandbox-off-gate-agent-");
  const cwd = await temporaryDirectory("sandbox-off-gate-project-");
  await saveSandboxSettings(
    agentDir,
    parseSandboxSettings({ permission: permissionForCwd(cwd) }),
    undefined,
  );
  return {
    cwd,
    review: (toolName: string, input: Record<string, unknown>) =>
      reviewHostAction({ agentDir, toolName, input, ctx: { cwd } as never }),
  };
}

it("keeps an explicit relative path deny effective for host reads", async () => {
  const fixture = await hostGateFixture(() => ({ path: { "secrets/*": "deny" } }));
  await expect(fixture.review("read", { path: "secrets/token.txt" })).rejects.toThrow(
    "Path denied by explicit policy",
  );
  await expect(fixture.review("read", { path: "src/app.ts" })).resolves.toBeUndefined();
});

it("matches an absolute host path deny against a cwd-relative tool path", async () => {
  const fixture = await hostGateFixture((cwd) => ({ path: { [join(cwd, ".env")]: "deny" } }));
  await expect(fixture.review("write", { path: ".env", content: "" })).rejects.toThrow(
    "Path denied by explicit policy",
  );
});

it("keeps explicit shell command and shell path denies effective for host Bash", async () => {
  const fixture = await hostGateFixture(() => ({
    bash: { "git push*": "deny" },
    path: { "*.pem": "deny" },
  }));
  await expect(fixture.review("bash", { command: "git push origin main" })).rejects.toThrow(
    "Shell command denied by explicit policy",
  );
  await writeFile(join(fixture.cwd, "server.pem"), "key");
  await expect(fixture.review("bash", { command: "cat server.pem" })).rejects.toThrow(
    "Shell path denied by explicit policy",
  );
  await expect(fixture.review("bash", { command: "uname -a" })).resolves.toBeUndefined();
});

it("routes guest tools to the host gate without touching the session while off", async () => {
  const agentDir = await temporaryDirectory("sandbox-off-routing-");
  const cwd = await temporaryDirectory("sandbox-off-routing-project-");
  await saveSandboxSettings(
    agentDir,
    parseSandboxSettings({ permission: { bash: "deny" } }),
    undefined,
  );
  const getSession = vi.fn(() => {
    throw new Error("Sandbox is off for this session; run /sandbox on");
  });
  await expect(
    reviewSandboxToolCall({
      tool: {
        name: "bash",
        sourceInfo: { path: "/installed/pi-permission-system/src/index.ts" },
      } as ToolInfo,
      getSession,
      isHostMode: () => true,
      agentDir,
      input: { command: "uname" },
      ctx: { cwd } as never,
    }),
  ).rejects.toThrow("Tool denied by explicit policy");
  expect(getSession).not.toHaveBeenCalled();
});
