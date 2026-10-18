import { readFile } from "node:fs/promises";
import { cliHostEnvironment } from "./devcontainer-cli.ts";
import type { PreparedEnvironment } from "./driver.ts";
import { JsonLineChannel } from "./json-line-channel.ts";

const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface GuestFilesystemTiming {
  operation: string;
  milliseconds: number;
  outcome: "ok" | "error" | "timeout";
}

export type GuestChannelStarter = (
  environment: PreparedEnvironment,
  serverScript: string,
) => JsonLineChannel;

export function podmanGuestChannel(
  environment: PreparedEnvironment,
  serverScript: string,
): JsonLineChannel {
  const environmentArguments = Object.entries(environment.remoteEnvironment ?? {}).flatMap(
    ([name, value]) => ["--env", `${name}=${value}`],
  );
  return new JsonLineChannel({
    args: [
      "exec",
      "-i",
      "--user",
      environment.user,
      "--workdir",
      environment.workspace,
      ...environmentArguments,
      environment.container,
      "python3",
      "-u",
      "-c",
      serverScript,
      "--serve",
    ],
    env: cliHostEnvironment(),
    label: "Guest filesystem transport",
    maxMessageBytes: MAX_MESSAGE_BYTES,
  });
}

/**
 * Serves filesystem requests through one long-lived guest process per container. A lost process
 * is replaced on the next request; a slow request times out alone without stopping the server.
 */
export class GuestFilesystemTransport {
  private channel?: JsonLineChannel;
  private channelContainer?: string;
  private serverScript?: Promise<string>;

  constructor(
    private readonly options: {
      start?: GuestChannelStarter;
      timing?: (timing: GuestFilesystemTiming) => void;
      requestTimeoutMs?: number;
    } = {},
  ) {}

  private loadServerScript(): Promise<string> {
    this.serverScript ??= readFile(new URL("./guest-filesystem.py", import.meta.url), "utf8");
    return this.serverScript;
  }

  private async channelFor(environment: PreparedEnvironment): Promise<JsonLineChannel> {
    const reusable =
      this.channel && !this.channel.failed && this.channelContainer === environment.container;
    if (reusable) {
      return this.channel!;
    }
    void this.channel?.close().catch(() => {});
    const start = this.options.start ?? podmanGuestChannel;
    this.channel = start(environment, await this.loadServerScript());
    this.channelContainer = environment.container;
    return this.channel;
  }

  async request(
    environment: PreparedEnvironment,
    payload: Record<string, unknown> & { operation: string },
    signal?: AbortSignal,
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const channel = await this.channelFor(environment);
    const startedAt = performance.now();
    const { id, response } = channel.send(payload);
    let outcome: GuestFilesystemTiming["outcome"] = "ok";
    const timer = setTimeout(() => {
      outcome = "timeout";
      channel.abandon(id, new Error(`Guest ${payload.operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const abort = () => channel.abandon(id, signal!.reason ?? new Error("Operation aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await response;
    } catch (error) {
      if (outcome === "ok") {
        outcome = "error";
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.options.timing?.({
        operation: payload.operation,
        milliseconds: Math.round(performance.now() - startedAt),
        outcome,
      });
    }
  }

  async close(): Promise<void> {
    const channel = this.channel;
    this.channel = undefined;
    this.channelContainer = undefined;
    await channel?.close().catch(() => {});
  }
}
