import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const DEVCONTAINER_CLI_VERSION = "0.89.0";

export function devcontainerExecutable(): string {
  return join(dirname(require.resolve("@devcontainers/cli/package.json")), "devcontainer.js");
}

export function cliHostEnvironment(
  additionalVariableNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", ...additionalVariableNames]) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

export async function readDevcontainerConfiguration(options: {
  configPath: string;
  workspaceFolder: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<string> {
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "pi-devcontainer-config-"));
  const enginePath = join(directory, "configuration-engine");
  const quoteShellArgument = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    const engineScript = fileURLToPath(new URL("./configuration-engine.mjs", import.meta.url));
    await writeFile(
      enginePath,
      `#!/bin/sh\nexec ${quoteShellArgument(process.execPath)} ${quoteShellArgument(engineScript)} "$@"\n`,
      { mode: 0o700, flag: "wx" },
    );
    await chmod(enginePath, 0o700);
    options.signal?.throwIfAborted();
    return await runDevcontainerCli({
      args: [
        "read-configuration",
        "--workspace-folder",
        options.workspaceFolder,
        "--config",
        options.configPath,
        "--docker-path",
        enginePath,
        "--mount-workspace-git-root",
        "false",
        "--mount-git-worktree-common-dir",
        "false",
      ],
      cwd: options.workspaceFolder,
      env: options.env,
      signal: options.signal,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runDevcontainerCli(options: {
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  progress?: (text: string) => void;
  diagnostic?: (text: string) => void;
  includeStdoutDiagnostic?: boolean;
}): Promise<string> {
  options.signal?.throwIfAborted();
  const child = spawn(process.execPath, [devcontainerExecutable(), ...options.args], {
    cwd: options.cwd,
    env: options.env ?? cliHostEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const output: Buffer[] = [];
  let outputBytes = 0;
  let stderr = "";
  const maxOutputBytes = 2 * 1024 * 1024;
  let outputExceeded = false;
  let timedOut = false;
  const stop = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs ?? 120_000);
  options.signal?.addEventListener("abort", stop, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    if (options.includeStdoutDiagnostic ?? true) {
      options.diagnostic?.(`devcontainer ${options.args[0]} stdout: ${chunk.toString()}`);
    }
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) {
      outputExceeded = true;
      stop();
      return;
    }
    output.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-12_000);
    options.progress?.(chunk.toString());
    options.diagnostic?.(`devcontainer ${options.args[0]} stderr: ${chunk.toString()}`);
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    options.signal?.throwIfAborted();
    if (timedOut) {
      throw new Error("Devcontainer operation timed out");
    }
    if (outputExceeded) {
      throw new Error("Devcontainer output exceeds 2 MiB");
    }
    if (code !== 0) {
      throw new Error(`Devcontainer operation failed (${code}): ${stderr}`);
    }
    return Buffer.concat(output).toString("utf8");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  }
}
