import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import { constants as osConstants } from "node:os";
import { z } from "zod";
import type { ProjectLocation } from "@paulsteele/pi-project-locations";
import { checkPolicy } from "../policy.ts";
import { guestToHost, validateMountIdentity, type MountGrant } from "./mounts.ts";
import type { VolumeGrant } from "./volumes.ts";
import { isPathInside } from "./storage.ts";
import { loadSandboxSettings } from "./settings.ts";
import {
  loadHostCommandProfile,
  resolveHostExecutable,
  type HostCommandProfile,
} from "./host-command-profile.ts";
import { shellQuote, type HostCommandPlan, type HostInvocation } from "./host-command-plan.ts";
import { BashProgram } from "../access-intent/bash/program.ts";
import { PathNormalizer } from "../path-normalizer.ts";

const MAX_ARGUMENT_BYTES = 256 * 1024;
const startRequest = z.strictObject({
  type: z.literal("start"),
  token: z.string(),
  invocation: z.number().int().nonnegative(),
  command: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !value.includes("\0")),
  args: z
    .array(
      z
        .string()
        .max(MAX_ARGUMENT_BYTES)
        .refine((value) => !value.includes("\0")),
    )
    .max(4096),
  cwd: z.string().min(1).max(4096),
  environment: z.record(
    z.string(),
    z
      .string()
      .max(16000)
      .refine((value) => !value.includes("\0")),
  ),
});
export type HostBridgeReply =
  | { type: "stdout" | "stderr"; data: string }
  | { type: "exit"; code: number }
  | { type: "stdin_ack" | "stdin_closed" };

export function stopHostProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export class HostCommandBroker {
  private readonly connections = new Map<
    number,
    {
      controller: AbortController;
      child?: ChildProcessWithoutNullStreams;
      finished?: Promise<void>;
      inputEnded: boolean;
      pendingInput: Buffer[];
      pendingBytes: number;
    }
  >();

  constructor(
    private readonly options: {
      agentDir: string;
      project: ProjectLocation;
      profile: HostCommandProfile;
      plan: HostCommandPlan;
      token: string;
      mounts: readonly MountGrant[];
      volumes?: readonly VolumeGrant[];
      canonicalGuestPath(path: string): Promise<string>;
      signal: AbortSignal;
      send(id: number, message: HostBridgeReply): void;
    },
  ) {}

  receive(id: number, raw: unknown): void {
    if (!raw || typeof raw !== "object") {
      throw new Error("Invalid host bridge message");
    }
    const message = raw as { type?: unknown; data?: unknown };
    if (message.type === "start") {
      if (this.connections.has(id)) {
        throw new Error("Host invocation already started");
      }
      const connection = {
        controller: new AbortController(),
        inputEnded: false,
        pendingInput: [] as Buffer[],
        pendingBytes: 0,
        finished: undefined as Promise<void> | undefined,
      };
      this.connections.set(id, connection);
      connection.finished = this.start(id, raw)
        .catch((error) => {
          this.options.send(id, {
            type: "stderr",
            data: Buffer.from(`Host routing failed: ${String(error)}\n`).toString("base64"),
          });
          this.options.send(id, { type: "exit", code: 125 });
        })
        .finally(() => {
          this.connections.delete(id);
        });
      return;
    }
    const connection = this.connections.get(id);
    if (message.type === "output_ack") {
      const channel = (raw as { channel?: unknown }).channel;
      if (channel === "stdout") {
        connection?.child?.stdout.resume();
      } else if (channel === "stderr") {
        connection?.child?.stderr.resume();
      }
      return;
    }
    if (!connection) {
      const isInputForClosedInvocation =
        message.type === "stdin_end" ||
        (message.type === "stdin" && typeof message.data === "string");
      if (isInputForClosedInvocation) {
        this.options.send(id, { type: "stdin_closed" });
        return;
      }
      throw new Error("Invalid message for an inactive host invocation");
    }
    if (message.type === "stdin_end") {
      connection.inputEnded = true;
      connection.child?.stdin.end();
      return;
    }
    if (message.type !== "stdin" || typeof message.data !== "string" || connection.inputEnded) {
      throw new Error("Invalid host stdin message");
    }
    const data = Buffer.from(message.data, "base64");
    if (connection.child) {
      connection.child.stdin.write(data, (error) => this.acknowledgeInput(id, error));
    } else {
      connection.pendingBytes += data.length;
      if (connection.pendingBytes > MAX_ARGUMENT_BYTES) {
        throw new Error("Host invocation input exceeded its startup buffer");
      }
      connection.pendingInput.push(data);
    }
  }

  private acknowledgeInput(id: number, error?: Error | null): void {
    const replyType = error ? "stdin_closed" : "stdin_ack";
    this.options.send(id, { type: replyType });
  }

  disconnect(id: number): void {
    const connection = this.connections.get(id);
    connection?.controller.abort();
    if (connection?.child) {
      stopHostProcess(connection.child);
    }
  }

  async close(): Promise<void> {
    for (const id of this.connections.keys()) {
      this.disconnect(id);
    }
    await Promise.allSettled(
      [...this.connections.values()].map((connection) => connection.finished),
    );
  }

  private async authorizeHostExecution(
    request: z.output<typeof startRequest>,
    invocation: HostInvocation,
  ): Promise<{ cwd: string; executable: string }> {
    const profile = await loadHostCommandProfile(this.options.agentDir, this.options.project);
    if (profile.revision !== this.options.profile.revision) {
      throw new Error("Host command rules changed; retry the Bash call");
    }
    const rule = profile.rules[invocation.ruleIndex];
    if (!rule) {
      throw new Error("Host command rule is unavailable");
    }
    for (const mount of this.options.mounts) {
      await validateMountIdentity(mount);
    }
    const canonicalCwd = await this.options.canonicalGuestPath(request.cwd);
    const mappedCwd = guestToHost(canonicalCwd, this.options.mounts, this.options.volumes);
    if (!mappedCwd) {
      throw new Error("Host command cwd has no approved mapping");
    }
    const cwd = await realpath(mappedCwd);
    if (!isPathInside(this.options.project.root, cwd) || !(await stat(cwd)).isDirectory()) {
      throw new Error("Host commands require a mapped working directory inside this project");
    }
    let hostCommand = request.command;
    if ("script" in rule) {
      const guestScript = await this.options.canonicalGuestPath(
        posix.resolve(canonicalCwd, request.command),
      );
      const mappedScript = guestToHost(guestScript, this.options.mounts, this.options.volumes);
      if (!mappedScript) {
        throw new Error("Host script has no approved guest mapping");
      }
      hostCommand = mappedScript;
    }
    let matchingRule = rule;
    if ("script" in rule) {
      let matchingScriptRule: typeof rule | undefined;
      for (const candidate of profile.rules) {
        if (!("script" in candidate)) {
          continue;
        }
        const candidatePath = await realpath(
          posix.resolve(this.options.project.root, candidate.script),
        );
        if (candidatePath === hostCommand) {
          matchingScriptRule = candidate;
          break;
        }
      }
      if (!matchingScriptRule) {
        throw new Error(
          `Host script does not match the configured project path: ${request.command}`,
        );
      }
      matchingRule = matchingScriptRule;
    }
    if (!matchingRule) {
      throw new Error(`Host script does not match the configured project path: ${request.command}`);
    }
    const executable = await resolveHostExecutable(
      matchingRule,
      this.options.project.root,
      cwd,
      hostCommand,
    );
    const settings = await loadSandboxSettings(this.options.agentDir);
    const commandText = [request.command, ...request.args].join(" ");
    if (
      settings.needsMigration ||
      checkPolicy(settings.settings.permission, "bash", "bash").state === "deny" ||
      checkPolicy(settings.settings.permission, "bash", commandText).state === "deny" ||
      [cwd, executable].some(
        (path) => checkPolicy(settings.settings.permission, "path", path).state === "deny",
      )
    ) {
      throw new Error("Host command denied by explicit policy or pending sandbox migration");
    }
    const expandedProgram = await BashProgram.parse(
      [request.command, ...request.args].map(shellQuote).join(" "),
      new PathNormalizer(cwd),
    );
    const deniesArgumentPath = expandedProgram
      .pathRuleCandidates()
      .some(({ path }) =>
        path
          .matchValues()
          .some(
            (alias) => checkPolicy(settings.settings.permission, "path", alias).state === "deny",
          ),
      );
    if (deniesArgumentPath) {
      throw new Error("Host argument path denied by explicit policy");
    }
    if ((await loadSandboxSettings(this.options.agentDir)).revision !== settings.revision) {
      throw new Error("Host permission settings changed during authorization");
    }
    if (
      (await loadHostCommandProfile(this.options.agentDir, this.options.project)).revision !==
      profile.revision
    ) {
      throw new Error("Host command rules changed during authorization");
    }
    return { cwd, executable };
  }

  private async start(id: number, raw: unknown): Promise<void> {
    const request = startRequest.parse(raw);
    const invocation = this.options.plan.invocations[request.invocation];
    if (
      !invocation ||
      request.token !== this.options.token ||
      request.command !== invocation.command
    ) {
      throw new Error("Host request is outside this Bash call's routing plan");
    }
    if (Buffer.byteLength(JSON.stringify(request.args)) > MAX_ARGUMENT_BYTES) {
      throw new Error("Host command arguments exceed 256 KiB");
    }
    if (
      Object.keys(request.environment).some((name) => !invocation.environmentNames.includes(name))
    ) {
      throw new Error("Host environment override was not declared by this invocation");
    }
    const connection = this.connections.get(id)!;
    const signal = AbortSignal.any([this.options.signal, connection.controller.signal]);
    const { cwd, executable } = await this.authorizeHostExecution(request, invocation);
    signal.throwIfAborted();
    this.options.send(id, {
      type: "stderr",
      data: Buffer.from(`[HOST] ${request.command} · ${cwd}\n`).toString("base64"),
    });
    const child = spawn(executable, request.args, {
      cwd,
      env: { ...process.env, ...request.environment },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    connection.child = child;
    const abort = () => stopHostProcess(child);
    signal.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () => this.options.send(id, { type: "stdin_closed" }));
    for (const data of connection.pendingInput) {
      child.stdin.write(data, (error) => this.acknowledgeInput(id, error));
    }
    connection.pendingInput = [];
    if (connection.inputEnded) {
      child.stdin.end();
    }
    child.stdout.on("data", (data: Buffer) => {
      child.stdout.pause();
      this.options.send(id, { type: "stdout", data: data.toString("base64") });
    });
    child.stderr.on("data", (data: Buffer) => {
      child.stderr.pause();
      this.options.send(id, { type: "stderr", data: data.toString("base64") });
    });
    child.once("exit", () => stopHostProcess(child));
    const processFinished = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, terminationSignal) => {
        const exitCode =
          code ?? (terminationSignal ? 128 + osConstants.signals[terminationSignal] : 125);
        this.options.send(id, { type: "exit", code: exitCode });
        resolve();
      });
    });
    try {
      await processFinished;
    } finally {
      signal.removeEventListener("abort", abort);
      stopHostProcess(child);
      delete connection.child;
    }
  }
}
