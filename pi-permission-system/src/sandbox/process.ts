import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cliHostEnvironment } from "./devcontainer-cli.ts";
import { podmanOutput } from "./driver.ts";

export const processSupervisor = `import os
import pathlib
import signal
import subprocess
import sys

record = pathlib.Path(sys.argv[1])
record.parent.mkdir(parents=True, exist_ok=True)
process = subprocess.Popen(sys.argv[2:], start_new_session=True)
record.write_text(str(process.pid))
def stop_process_group(signum, frame):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    record.unlink(missing_ok=True)
    sys.exit(128 + signum)
signal.signal(signal.SIGTERM, stop_process_group)
signal.signal(signal.SIGHUP, stop_process_group)
try:
    status = process.wait()
finally:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    record.unlink(missing_ok=True)
sys.exit(status if status >= 0 else 128 - status)`;

export interface GuestProcessOptions {
  container: string;
  user: string;
  cwd: string;
  command: string[];
  environment?: Record<string, string>;
  input?: Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  onData?: (data: Buffer) => void;
}

export async function runGuestProcess(
  options: GuestProcessOptions,
): Promise<{ output: Buffer; stderr: string; code: number }> {
  options.signal?.throwIfAborted();
  const record = `/tmp/pi-sandbox-processes/${randomUUID()}`;
  const environment = Object.entries(options.environment ?? {}).flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`,
  ]);
  const child = spawn(
    "podman",
    [
      "exec",
      "-i",
      "--user",
      options.user,
      "--workdir",
      options.cwd,
      ...environment,
      options.container,
      "python3",
      "-u",
      "-c",
      processSupervisor,
      record,
      ...options.command,
    ],
    {
      env: cliHostEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const output: Buffer[] = [];
  let bytes = 0;
  let stderr = "";
  let timedOut = false;
  let exceeded = false;
  const terminateRecordedProcess = `import os
import pathlib
import signal
import sys
import time

process_record = pathlib.Path(sys.argv[1])
startup_wait_attempts = 100
startup_wait_seconds = 0.01
for attempt in range(startup_wait_attempts):
    if process_record.exists():
        try:
            os.killpg(int(process_record.read_text()), signal.SIGKILL)
        except ProcessLookupError:
            pass
        break
    time.sleep(startup_wait_seconds)`;
  let hostExecTerminated = false;
  const terminateHostExec = () => {
    if (hostExecTerminated) {
      return;
    }
    hostExecTerminated = true;
    child.kill("SIGKILL");
  };
  let termination: Promise<void> | undefined;
  const stop = () => {
    termination ??= (async () => {
      const cancellation = new AbortController();
      const terminationTimeoutMs = 5_000;
      const terminationTimer = setTimeout(() => {
        cancellation.abort(new Error("Guest process termination timed out"));
        terminateHostExec();
      }, terminationTimeoutMs);
      try {
        await podmanOutput(
          [
            "exec",
            "--user",
            options.user,
            options.container,
            "python3",
            "-c",
            terminateRecordedProcess,
            record,
          ],
          cancellation.signal,
        );
      } finally {
        clearTimeout(terminationTimer);
        terminateHostExec();
      }
    })();
    return termination;
  };
  const abort = () => {
    void stop().catch(terminateHostExec);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        abort();
      }, options.timeoutMs)
    : undefined;
  child.stdout.on("data", (data: Buffer) => {
    options.onData?.(data);
    bytes += data.length;
    if (bytes > 16 * 1024 * 1024) {
      exceeded = true;
      abort();
    } else {
      output.push(data);
    }
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-16_000);
    options.onData?.(data);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    options.signal?.throwIfAborted();
    if (timedOut) {
      throw new Error("Guest process timed out");
    }
    if (exceeded) {
      throw new Error("Guest process output exceeds 16 MiB");
    }
    return { output: Buffer.concat(output), stderr, code: code ?? 1 };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
