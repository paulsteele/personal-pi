import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SandboxSession } from "../src/sandbox/session.ts";
import type { ResolvedDefinition } from "../src/sandbox/definition.ts";
import { hostCommandProfilePath } from "../src/sandbox/host-command-profile.ts";
import { registerSandboxTools } from "../src/sandbox/tools.ts";

const ports = vi.hoisted(() => ({
  create: vi.fn(),
  podman: vi.fn(),
  forward: vi.fn(),
  shell: vi.fn(),
}));
vi.mock("../src/sandbox/driver.ts", () => ({
  createDevcontainer: ports.create,
  podmanOutput: ports.podman,
}));
vi.mock("../src/sandbox/ports.ts", () => ({
  devcontainerPorts: () => [],
  startLoopbackForwarders: ports.forward,
}));
vi.mock("../src/sandbox/host-command-runner.ts", async (original) => ({
  ...(await original<typeof import("../src/sandbox/host-command-runner.ts")>()),
  executeProjectShell: ports.shell,
}));
const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function sessionFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "host-command-session-")));
  directories.push(directory);
  const root = join(directory, "project");
  const agentDir = join(directory, "agent");
  await mkdir(root);
  const resolved: ResolvedDefinition = {
    path: join(directory, "devcontainer.json"),
    sourceText: '{"image":"debian"}',
    revision: "base",
    tier: "global",
    startupDirectory: root,
    project: { id: "a".repeat(64), kind: "projects", root },
    definition: { image: "debian" },
  };
  const session = new SandboxSession({
    agentDir,
    sessionId: "session",
    resolved,
    hostEnvironment: [],
    confirm: vi.fn(async () => true),
  });
  ports.create.mockResolvedValue({
    container: "container",
    image: "debian",
    user: "root",
    workspace: root,
    configuration: {},
  });
  ports.podman.mockResolvedValue("");
  ports.forward.mockResolvedValue({ close: vi.fn(async () => {}) });
  await session.start();
  return { session, agentDir, resolved };
}

it("routes the Bash tool and user shell through the same session shell entry point", async () => {
  const executeShell = vi.fn(async () => ({ code: 0, output: Buffer.alloc(0), stderr: "" }));
  const definitions = new Map<string, any>();
  let userBash: (() => any) | undefined;
  registerSandboxTools(
    {
      registerTool(tool: { name: string }) {
        definitions.set(tool.name, tool);
      },
      on(event: string, handler: () => any) {
        if (event === "user_bash") {
          userBash = handler;
        }
      },
    } as never,
    () => ({ executeShell, filesystem: {}, environment: { workspace: "/workspace" } }) as never,
  );
  const signal = new AbortController().signal;
  await definitions
    .get("bash")
    .execute("bash-1", { command: "dotnet build", timeout: 2 }, signal, undefined, {});
  expect(executeShell).toHaveBeenCalledWith(
    expect.objectContaining({ command: "dotnet build", timeoutMs: 2000, signal }),
  );
  await userBash!().operations.exec("./build.sh", "/ignored", { onData() {}, signal });
  expect(executeShell).toHaveBeenLastCalledWith(
    expect.objectContaining({ command: "./build.sh", signal }),
  );
});

it("aborts active routed shells during container replacement and waits for their termination", async () => {
  const { session, resolved } = await sessionFixture();
  let terminated = false;
  ports.shell.mockImplementation(async (owner: SandboxSession) => {
    const controller = new AbortController();
    const retire = owner.beforeContainerRetirement(async () => {
      controller.abort();
    });
    try {
      await new Promise<void>((resolve) =>
        controller.signal.addEventListener(
          "abort",
          () => {
            terminated = true;
            resolve();
          },
          { once: true },
        ),
      );
      return { code: 137, output: Buffer.alloc(0), stderr: "" };
    } finally {
      retire();
    }
  });
  const active = session.executeShell({ command: "dotnet build" });
  try {
    await session.rebuildFromDefinition({ ...resolved, revision: "new-tools" });
    await active;
    expect(terminated).toBe(true);
    expect(session.generation).toBe(2);
  } finally {
    await session.close();
  }
});

it("cancels active shells and rejects new work while retirement listeners are still draining", async () => {
  const { session, resolved } = await sessionFixture();
  const { promise: retirementWait, resolve: releaseRetirement } = Promise.withResolvers<void>();
  const retirementListener = vi.fn(() => retirementWait);
  session.beforeContainerRetirement(retirementListener);
  ports.shell.mockImplementation(async (_owner: SandboxSession, options: { signal: AbortSignal }) => {
    await new Promise<void>((resolve) => {
      options.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { code: 137, output: Buffer.alloc(0), stderr: "" };
  });
  const active = session.executeShell({ command: "dotnet test" });
  const replacement = session.rebuildFromDefinition({ ...resolved, revision: "new-tools" });
  try {
    await vi.waitFor(() => expect(retirementListener).toHaveBeenCalledOnce());
    expect((await active).code).toBe(137);
    await expect(session.executeShell({ command: "new work" })).rejects.toThrow("not ready");
    expect(ports.shell).toHaveBeenCalledOnce();
  } finally {
    releaseRetirement();
    await replacement;
    await session.close();
  }
});

it("uses the session lifetime to cancel routed shells on shutdown", async () => {
  const { session } = await sessionFixture();
  ports.shell.mockImplementation(
    async (_owner: SandboxSession, options: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) =>
        options.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { code: 137, output: Buffer.alloc(0), stderr: "" };
    },
  );
  const active = session.executeShell({ command: "dotnet test" });
  await session.close();
  expect((await active).code).toBe(137);
});

it("does not launch a native bridge for unmatched commands or absent rules", async () => {
  const fixture = await sessionFixture();
  const actualRunner = await vi.importActual<
    typeof import("../src/sandbox/host-command-runner.ts")
  >("../src/sandbox/host-command-runner.ts");
  const execute = vi.fn(async () => ({ code: 0, output: Buffer.from("guest"), stderr: "" }));
  const guestOnly = { options: fixture.session.options, execute };
  try {
    expect(
      (
        await actualRunner.executeProjectShell(guestOnly as never, { command: "echo guest" })
      ).output.toString(),
    ).toBe("guest");
    const profilePath = hostCommandProfilePath(fixture.agentDir, fixture.resolved.project);
    await mkdir(dirname(profilePath), { recursive: true });
    await writeFile(profilePath, JSON.stringify({ hostCommands: [{ executable: "dotnet" }] }));
    await actualRunner.executeProjectShell(guestOnly as never, { command: "git diff" });
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: ["bash", "-c", "git diff"] }),
    );
  } finally {
    await fixture.session.close();
  }
});
