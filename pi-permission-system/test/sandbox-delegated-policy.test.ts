import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import sandboxExtension from "../src/sandbox-extension.ts";
import { createMountGrant } from "../src/sandbox/mounts.ts";
import { globalToolProfilePath, defaultToolProfile } from "../src/sandbox/tool-profile.ts";
import { parseSandboxSettings, saveSandboxSettings } from "../src/sandbox/settings.ts";
import type { DelegatedReviewService } from "../src/delegated-review.ts";
import { PermissionScope } from "../../pr-review/permissions.ts";
import { registryStream, type Registry } from "../../pr-review/worker.ts";
import { testConfig } from "../../pr-review/test-fixtures.ts";

const ports = vi.hoisted(() => ({
  session: undefined as unknown,
  canonicalPaths: vi.fn(async (paths: string[]) => paths),
}));
vi.mock("../src/sandbox/session.ts", () => ({ SandboxSession: class {
  constructor() { Object.assign(this, ports.session); }
} }));
vi.mock("../src/sandbox/definition.ts", async (original) => ({
  ...(await original<typeof import("../src/sandbox/definition.ts")>()),
  selectDefinition: async () => ({ path: "/private/devcontainer.json" }),
  resolveDefinition: async () => ({ path: "/private/devcontainer.json", definition: {} }),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  ports.canonicalPaths.mockReset().mockImplementation(async (paths) => paths);
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function loadedServiceFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sandbox-live-disclosure-")));
  directories.push(directory);
  const root = join(directory, "project");
  const agentDir = join(directory, "agent");
  await mkdir(root);
  const toolsPath = globalToolProfilePath(agentDir);
  await mkdir(join(agentDir, "extensions/pi-permission-system/global"), { recursive: true });
  await writeFile(toolsPath, JSON.stringify(defaultToolProfile()));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const mount = await createMountGrant({ path: root, destination: "/workspace", access: "rw", privateStorage: agentDir });
  ports.session = {
    options: { agentDir, sessionId: "session", confirm: async () => false },
    revision: "authority", mounts: [mount], generation: 1,
    environment: { container: "container", user: "root", workspace: "/workspace", configuration: {}, remoteEnvironment: { HOME: "/root" } },
    filesystem: { canonicalPaths: ports.canonicalPaths },
    start: async () => {}, close: async () => {}, beforeContainerRetirement: () => () => {},
  };
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const subscribers = new Map<string, Set<(value: unknown) => void>>();
  const events = {
    on(name: string, subscriber: (value: unknown) => void) {
      const listeners = subscribers.get(name) ?? new Set();
      listeners.add(subscriber);
      subscribers.set(name, listeners);
      return () => listeners.delete(subscriber);
    },
    emit(name: string, value: unknown) {
      for (const subscriber of subscribers.get(name) ?? []) {
        subscriber(value);
      }
    },
  };
  sandboxExtension({ events, on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler),
    registerTool() {}, registerCommand() {}, registerEntryRenderer() {},
  } as never);
  const ctx = { cwd: root, mode: "rpc", hasUI: true,
    sessionManager: { getSessionId: () => "session" }, ui: { notify: vi.fn(), setStatus: vi.fn() },
  } as unknown as ExtensionContext;
  await handlers.get("session_start")!({}, ctx);
  let service: DelegatedReviewService | undefined;
  events.emit("permissions:review-service:v1", { version: 1, accept(value: DelegatedReviewService) { service = value; } });
  expect(service).toBeDefined();
  const operation = service!.open({ id: "review", sessionId: "session", cwd: root, scope: "fixture", signal: new AbortController().signal });
  const task = operation.task({ id: "host", name: "host", assignment: "Fixture output", model: "local", kind: "host",
    tools: ["read", "read_change", "search_source", "submit_result"],
  });
  const revokeA = () => saveSandboxSettings(agentDir, parseSandboxSettings({ permission: { path: { "/workspace/A": "deny" } } }), undefined);
  return { root, agentDir, task, scope: new PermissionScope(task), revokeA,
    close: () => handlers.get("session_shutdown")!({}, ctx),
  };
}

it("restarts loaded-service disclosure when an earlier source is revoked during a later probe", async () => {
  const fixture = await loadedServiceFixture();
  let revoked = false;
  ports.canonicalPaths.mockImplementation(async (paths) => {
    if (!revoked && paths.includes("/workspace/B")) {
      revoked = true;
      await fixture.revokeA();
    }
    return paths;
  });
  try {
    await expect(fixture.scope.authorizeSources([
      { path: join(fixture.root, "A") }, { path: join(fixture.root, "B") },
    ], "Publish")).rejects.toThrow("Path denied");
  } finally {
    await fixture.close();
  }
});

it("rechecks the loaded live-policy revision after provider authentication before dispatch", async () => {
  const fixture = await loadedServiceFixture();
  const providerDispatch = vi.fn();
  const denied = vi.fn();
  const registry = {
    getApiKeyAndHeaders: async () => {
      await fixture.revokeA();
      return { ok: true };
    },
    getProvider: () => ({ streamSimple: providerDispatch }),
  } as unknown as Registry;
  try {
    await fixture.scope.authorizeSources([{ path: join(fixture.root, "A") }], "Prepare");
    const stream = await registryStream(registry, testConfig, undefined, undefined, {
      scope: fixture.scope, wait: (operation) => operation(), denied,
    })({ provider: "fake", id: "model", api: "fake", contextWindow: 10000, maxTokens: 1000 } as never,
      { messages: [] } as never, {});
    expect((await stream.result()).stopReason).toBe("error");
    expect(providerDispatch).not.toHaveBeenCalled();
    expect(denied).toHaveBeenCalledOnce();
  } finally {
    await fixture.close();
  }
});

it.each(["read_change", "submit_result", "search_source"])("enforces the loaded logical tool deny for source-free %s", async (toolName) => {
  const fixture = await loadedServiceFixture();
  await saveSandboxSettings(fixture.agentDir, parseSandboxSettings({ permission: { [toolName]: "deny" } }), undefined);
  try {
    expect(await fixture.task.check({ toolName, input: {}, effects: [] })).toMatchObject({ kind: "denied" });
    if (toolName === "search_source") {
      expect(await fixture.task.checkLocalSearch({ toolName: "read", input: {}, effects: [] })).toMatchObject({ kind: "denied" });
    }
  } finally {
    await fixture.close();
  }
});
