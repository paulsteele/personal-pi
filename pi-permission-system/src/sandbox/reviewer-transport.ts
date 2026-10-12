import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

export class ReviewerFilesystemTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 0;
  private bufferedOutput = Buffer.alloc(0);
  private stderr = "";
  private failure?: Error;
  readonly closed: Promise<void>;

  constructor(options: { args: string[]; env: NodeJS.ProcessEnv; signal: AbortSignal }) {
    options.signal.throwIfAborted();
    this.child = spawn("podman", options.args, {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const abort = () => this.fail(new Error("Reviewer filesystem transport cancelled"));
    options.signal.addEventListener("abort", abort, { once: true });
    this.closed = new Promise<void>((resolve) => {
      this.child.once("close", (code) => {
        options.signal.removeEventListener("abort", abort);
        this.fail(new Error(`Reviewer filesystem transport exited (${code}): ${this.stderr}`));
        resolve();
      });
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-16_000);
    });
    if (options.signal.aborted) {
      abort();
    }
  }

  private fail(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    this.pending.clear();
    this.child.kill("SIGKILL");
  }

  private receive(chunk: Buffer): void {
    if (this.failure) {
      return;
    }
    this.bufferedOutput = Buffer.concat([this.bufferedOutput, chunk]);
    for (;;) {
      const newline = this.bufferedOutput.indexOf(10);
      if (newline < 0) {
        if (this.bufferedOutput.length > MAX_RESPONSE_BYTES) {
          this.fail(new Error("Reviewer filesystem response exceeds transport limit"));
        }
        return;
      }
      if (newline > MAX_RESPONSE_BYTES) {
        this.fail(new Error("Reviewer filesystem response exceeds transport limit"));
        return;
      }
      const line = this.bufferedOutput.subarray(0, newline).toString();
      this.bufferedOutput = this.bufferedOutput.subarray(newline + 1);
      let response: { id: number; result?: unknown; error?: string };
      try {
        response = JSON.parse(line);
        if (!response || !Number.isSafeInteger(response.id) || !this.pending.has(response.id)) {
          throw new Error("Invalid reviewer filesystem response identity");
        }
      } catch {
        this.fail(new Error("Invalid reviewer filesystem response"));
        return;
      }
      const request = this.pending.get(response.id)!;
      this.pending.delete(response.id);
      request.cleanup();
      if (typeof response.error === "string") {
        request.reject(new Error(`Reviewer filesystem request failed: ${response.error}`));
      } else {
        request.resolve(response.result);
      }
    }
  }

  request(
    operation: "ready" | "canonical_paths",
    paths: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    const id = ++this.nextRequestId;
    const encoded = JSON.stringify({ id, operation, paths }) + "\n";
    if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) {
      return Promise.reject(new Error("Reviewer filesystem request exceeds transport limit"));
    }
    return new Promise((resolve, reject) => {
      const abort = () => this.fail(new Error("Reviewer filesystem request cancelled"));
      const timer = setTimeout(
        () => this.fail(new Error("Reviewer filesystem request timed out")),
        REQUEST_TIMEOUT_MS,
      );
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      });
      if (signal?.aborted) {
        abort();
        return;
      }
      this.child.stdin.write(encoded);
    });
  }

  async canonicalPaths(paths: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const result = await this.request("canonical_paths", paths, signal);
    if (
      !Array.isArray(result) ||
      result.length !== paths.length ||
      result.some((path) => typeof path !== "string")
    ) {
      this.fail(new Error("Invalid reviewer canonical-path response"));
      throw this.failure;
    }
    return result;
  }

  async close(): Promise<void> {
    this.fail(new Error("Reviewer filesystem transport closed"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Reviewer filesystem transport did not close")),
            5_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
