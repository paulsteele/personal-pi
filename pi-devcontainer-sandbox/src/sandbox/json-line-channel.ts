import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

interface PendingResponse {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * One long-lived `podman exec -i` process speaking newline-delimited JSON. Every request carries a
 * numeric id that the server echoes back with either `result` or `error`.
 */
export class JsonLineChannel {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingResponse>();
  private readonly abandoned = new Set<number>();
  private nextRequestId = 0;
  private bufferedOutput = Buffer.alloc(0);
  private stderr = "";
  private failure?: Error;
  readonly closed: Promise<void>;

  constructor(
    private readonly options: {
      args: string[];
      env: NodeJS.ProcessEnv;
      label: string;
      maxMessageBytes: number;
    },
  ) {
    this.child = spawn("podman", options.args, {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.closed = new Promise<void>((resolve) => {
      this.child.once("close", (code) => {
        this.fail(new Error(`${options.label} exited (${code}): ${this.stderr}`));
        resolve();
      });
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-16_000);
    });
  }

  get failed(): Error | undefined {
    return this.failure;
  }

  fail(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    for (const response of this.pending.values()) {
      response.reject(error);
    }
    this.pending.clear();
    this.child.kill("SIGKILL");
  }

  /** Stops waiting for a request without stopping the server; its late response is discarded. */
  abandon(id: number, error: Error): void {
    const response = this.pending.get(id);
    if (!response) {
      return;
    }
    this.pending.delete(id);
    this.abandoned.add(id);
    response.reject(error);
  }

  send(payload: Record<string, unknown>): { id: number; response: Promise<unknown> } {
    const id = ++this.nextRequestId;
    if (this.failure) {
      return { id, response: Promise.reject(this.failure) };
    }
    const encoded = `${JSON.stringify({ ...payload, id })}\n`;
    if (Buffer.byteLength(encoded) > this.options.maxMessageBytes) {
      return {
        id,
        response: Promise.reject(
          new Error(`${this.options.label} request exceeds transport limit`),
        ),
      };
    }
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(encoded);
    return { id, response };
  }

  private receive(chunk: Buffer): void {
    if (this.failure) {
      return;
    }
    this.bufferedOutput = Buffer.concat([this.bufferedOutput, chunk]);
    for (;;) {
      const newline = this.bufferedOutput.indexOf(10);
      const exceedsLimit =
        newline < 0
          ? this.bufferedOutput.length > this.options.maxMessageBytes
          : newline > this.options.maxMessageBytes;
      if (exceedsLimit) {
        this.fail(new Error(`${this.options.label} response exceeds transport limit`));
        return;
      }
      if (newline < 0) {
        return;
      }
      const line = this.bufferedOutput.subarray(0, newline).toString();
      this.bufferedOutput = this.bufferedOutput.subarray(newline + 1);
      this.settle(line);
      if (this.failure) {
        return;
      }
    }
  }

  private settle(line: string): void {
    let message: { id: number; result?: unknown; error?: string };
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(new Error(`${this.options.label} sent an invalid response`));
      return;
    }
    if (this.abandoned.delete(message?.id)) {
      return;
    }
    const response = this.pending.get(message?.id);
    if (!response || !Number.isSafeInteger(message.id)) {
      this.fail(new Error(`${this.options.label} sent an invalid response identity`));
      return;
    }
    this.pending.delete(message.id);
    if (typeof message.error === "string") {
      response.reject(new Error(`${this.options.label} request failed: ${message.error}`));
    } else {
      response.resolve(message.result);
    }
  }

  async close(closeTimeoutMs = 5_000): Promise<void> {
    this.fail(new Error(`${this.options.label} closed`));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${this.options.label} did not close`)),
            closeTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
