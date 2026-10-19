import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isAuditedSandboxTool } from "../pi-devcontainer-sandbox/src/sandbox/gate.ts";

async function retireSandboxFixture(
  session: Pick<Awaited<ReturnType<typeof createAgentSession>>["session"], "extensionRunner" | "sessionId">,
  run: (args: string[]) => Promise<string>,
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    const ids = await run(["ps", "--all", "-q", "--filter", `label=pi.sandbox.session=${session.sessionId}`]);
    for (const id of ids.split(/\s+/).filter(Boolean)) {
      try {
        await run(["rm", "--force", "--time=0", "--ignore", id]);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Sandbox fixture cleanup failed");
  }
}

test("fixture teardown waits for shutdown and attempts every owned removal after failures", async () => {
  const calls: string[] = [];
  let finishShutdown!: () => void;
  const shutdownWait = new Promise<void>((resolve) => {
    finishShutdown = resolve;
  });
  const session = {
    sessionId: "fixture-session",
    extensionRunner: {
      async emit() {
        calls.push("shutdown");
        await shutdownWait;
        throw new Error("Shutdown failed");
      },
    },
  };
  const run = async (args: string[]) => {
    calls.push(args.join(" "));
    if (args[0] === "ps") {
      return "first\nsecond\n";
    }
    if (args.at(-1) === "first") {
      throw new Error("First removal failed");
    }
    return "";
  };
  const teardown = retireSandboxFixture(session as never, run).catch((error: unknown) => error);
  expect(calls).toEqual(["shutdown"]);
  finishShutdown();
  const cleanupFailure = await teardown;
  expect(cleanupFailure).toBeInstanceOf(AggregateError);
  expect((cleanupFailure as AggregateError).message).toBe("Sandbox fixture cleanup failed");
  expect(calls).toEqual([
    "shutdown",
    "ps --all -q --filter label=pi.sandbox.session=fixture-session",
    "rm --force --time=0 --ignore first",
    "rm --force --time=0 --ignore second",
  ]);
});

test("real Pi tool ownership recognizes sandbox reader overrides", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sandbox-loader-test-")));
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  let dispose: (() => void) | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const sandboxExtensionPath = join(import.meta.dir, "../pi-devcontainer-sandbox/src/index.ts");
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [sandboxExtensionPath] });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false });
    const created = await createAgentSession({ cwd, agentDir, resourceLoader, modelRuntime, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
    dispose = () => created.session.dispose();
    const tools = created.session.getAllTools();
    const reader = tools.find((tool) => tool.name === "read")!;
    expect(reader.sourceInfo.path).toBe(sandboxExtensionPath);
    expect(isAuditedSandboxTool(reader)).toBe(true);
  } finally {
    dispose?.();
    await rm(directory, { recursive: true, force: true });
  }
});
