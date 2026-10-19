import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { cliHostEnvironment } from "./devcontainer-cli.ts";
import { HostCommandBroker, stopHostProcess, type HostBridgeReply } from "./host-command-broker.ts";
import { loadHostCommandProfile, type HostCommandProfile } from "./host-command-profile.ts";
import {
  planHostCommands,
  rewriteHostCommands,
  shellQuote,
  type HostCommandPlan,
} from "./host-command-plan.ts";
import type { SandboxSession } from "./session.ts";
import { runGuestProcess } from "./process.ts";

const terminateGuestShell = `import os
import pathlib
import signal
import sys

process_record_path = pathlib.Path(sys.argv[1])
socket_path = pathlib.Path(sys.argv[2])
if process_record_path.exists():
    try:
        os.killpg(int(process_record_path.read_text()), signal.SIGKILL)
    except ProcessLookupError:
        pass
    process_record_path.unlink(missing_ok=True)
socket_path.unlink(missing_ok=True)`;

export interface ShellExecutionOptions {
  command: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onData?: (data: Buffer) => void;
}
export interface ShellExecutionResult {
  output: Buffer;
  stderr: string;
  code: number;
}

export async function executeProjectShell(
  session: SandboxSession,
  options: ShellExecutionOptions,
): Promise<ShellExecutionResult> {
  const profile = await loadHostCommandProfile(
    session.options.agentDir,
    session.options.resolved.project,
  );
  const plan = await planHostCommands(options.command, profile.rules);
  if (!plan.invocations.length) {
    return session.execute({ ...options, command: ["bash", "-c", options.command] });
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    ...(options.signal ? [options.signal] : []),
    ...(options.timeoutMs ? [AbortSignal.timeout(options.timeoutMs)] : []),
  ]);
  const retire = session.beforeContainerRetirement(async () => controller.abort());
  try {
    const [clientScript, relayScript] = await Promise.all([
      readFile(new URL("./host-command-client.py", import.meta.url), "utf8"),
      readFile(new URL("./host-command-relay.py", import.meta.url), "utf8"),
    ]);
    const environment = session.environment;
    const processRecord = `/tmp/pi-sandbox-processes/host-${randomUUID()}`;
    return await runHostRoutedShell({
      session,
      options,
      profile,
      plan,
      clientScript,
      relayScript,
      signal,
      terminateGuest: async (socketPath) => {
        await runGuestProcess({
          container: environment.container,
          user: environment.user,
          cwd: environment.workspace,
          command: ["python3", "-c", terminateGuestShell, processRecord, socketPath],
          signal: AbortSignal.timeout(5000),
        });
      },
      launch: {
        command: "podman",
        args: [
          "exec",
          "-i",
          "--user",
          environment.user,
          "--workdir",
          environment.workspace,
          ...Object.entries(environment.remoteEnvironment ?? {}).flatMap(([name, value]) => [
            "--env",
            `${name}=${value}`,
          ]),
          environment.container,
          "python3",
          "-u",
          "-c",
          session.processSupervisor,
          processRecord,
        ],
        env: cliHostEnvironment(),
      },
    });
  } finally {
    retire();
  }
}

export async function runHostRoutedShell(options: {
  session: Pick<SandboxSession, "options" | "mounts" | "filesystem" | "execute"> &
    Partial<Pick<SandboxSession, "volumes">>;
  options: ShellExecutionOptions;
  profile: HostCommandProfile;
  plan: HostCommandPlan;
  clientScript: string;
  relayScript: string;
  signal: AbortSignal;
  terminateGuest(socketPath: string): Promise<void>;
  launch: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string };
}): Promise<ShellExecutionResult> {
  options.signal.throwIfAborted();
  const token = randomUUID();
  const socketPath = `/tmp/pi-host-${randomUUID()}.sock`;
  const source = rewriteHostCommands(options.plan, (invocation) =>
    [
      "python3",
      "-u",
      "-c",
      options.clientScript,
      socketPath,
      token,
      String(options.plan.invocations.indexOf(invocation)),
      invocation.command,
      JSON.stringify(invocation.environmentNames),
    ]
      .map(shellQuote)
      .join(" "),
  );
  const child = spawn(
    options.launch.command,
    [...options.launch.args, "python3", "-u", "-c", options.relayScript, socketPath, source],
    {
      cwd: options.launch.cwd,
      env: options.launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    },
  );
  let transportOpen = true;
  let transportError: Error | undefined;
  let shellCode: number | undefined;
  let outputBytes = 0;
  let stderr = "";
  const output: Buffer[] = [];
  const maxOutputBytes = 16 * 1024 * 1024;
  const maximumQueuedBridgeBytes = 2 * 1024 * 1024;
  const send = (id: number, message: HostBridgeReply) => {
    if (transportOpen && !child.stdin.destroyed) {
      const encoded = `${JSON.stringify({ id, message })}\n`;
      if (child.stdin.writableLength + Buffer.byteLength(encoded) > maximumQueuedBridgeBytes) {
        failTransport(new Error("Native bridge output queue exceeds 2 MiB"));
        return;
      }
      child.stdin.write(encoded);
    }
  };
  const broker = new HostCommandBroker({
    agentDir: options.session.options.agentDir,
    project: options.session.options.resolved.project,
    profile: options.profile,
    plan: options.plan,
    token,
    mounts: [...options.session.mounts],
    volumes: [...(options.session.volumes ?? [])],
    canonicalGuestPath: (path) => options.session.filesystem.canonical(path, options.signal),
    signal: options.signal,
    send,
  });
  let termination: Promise<void> | undefined;
  const stop = () => {
    termination ??= (async () => {
      await broker.close();
      await options.terminateGuest(socketPath).catch(() => {});
      stopHostProcess(child);
    })();
    return termination;
  };
  const abort = () => {
    void stop();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  const failTransport = (error: unknown) => {
    transportError ??= error instanceof Error ? error : new Error(String(error));
    void stop();
  };
  const publishOutput = (data: Buffer, channel: string) => {
    outputBytes += data.length;
    if (outputBytes > maxOutputBytes) {
      failTransport(new Error("Routed shell output exceeds 16 MiB"));
      return;
    }
    if (channel === "stderr") {
      stderr = (stderr + data.toString()).slice(-16000);
    }
    output.push(data);
    options.options.onData?.(data);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      if (line.length > 1024 * 1024) {
        throw new Error("Host relay message exceeds 1 MiB");
      }
      type RelayMessage =
        | { type: "bridge"; id: number; message: unknown }
        | { type: "disconnect"; id: number }
        | { type: "output"; channel: "stdout" | "stderr"; data: string }
        | { type: "shell_exit"; code: number };
      const message = JSON.parse(line) as RelayMessage;
      if (message.type === "bridge") {
        if (!Number.isSafeInteger(message.id) || message.id < 1) {
          throw new Error("Invalid host relay connection");
        }
        broker.receive(message.id, message.message);
      } else if (message.type === "disconnect") {
        broker.disconnect(message.id);
      } else if (
        message.type === "output" &&
        ["stdout", "stderr"].includes(message.channel) &&
        typeof message.data === "string"
      ) {
        publishOutput(Buffer.from(message.data, "base64"), message.channel);
      } else if (message.type === "shell_exit" && Number.isInteger(message.code)) {
        shellCode = message.code;
      } else {
        throw new Error("Invalid host relay response");
      }
    } catch (error) {
      failTransport(error);
    }
  });
  child.stdin.on("error", failTransport);
  child.stderr.on("data", (data: Buffer) => publishOutput(data, "stderr"));
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    options.signal.throwIfAborted();
    if (transportError) {
      throw transportError;
    }
    if (code !== 0 || shellCode === undefined) {
      throw new Error(`Host relay failed before shell completion: ${stderr}`);
    }
    return { output: Buffer.concat(output), stderr, code: shellCode };
  } finally {
    transportOpen = false;
    options.signal.removeEventListener("abort", abort);
    lines.close();
    await stop();
  }
}
