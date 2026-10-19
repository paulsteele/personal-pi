import { JsonLineChannel } from "./json-line-channel.ts";

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export class ReviewerFilesystemTransport {
  private readonly channel: JsonLineChannel;
  readonly closed: Promise<void>;

  constructor(options: { args: string[]; env: NodeJS.ProcessEnv; signal: AbortSignal }) {
    options.signal.throwIfAborted();
    this.channel = new JsonLineChannel({
      args: options.args,
      env: options.env,
      label: "Reviewer filesystem transport",
      maxMessageBytes: MAX_RESPONSE_BYTES,
    });
    const abort = () => this.channel.fail(new Error("Reviewer filesystem transport cancelled"));
    options.signal.addEventListener("abort", abort, { once: true });
    this.closed = this.channel.closed.then(() =>
      options.signal.removeEventListener("abort", abort),
    );
  }

  async request(
    operation: "ready" | "canonical_paths",
    paths: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const { response } = this.channel.send({ operation, paths });
    const abort = () => this.channel.fail(new Error("Reviewer filesystem request cancelled"));
    const timer = setTimeout(
      () => this.channel.fail(new Error("Reviewer filesystem request timed out")),
      REQUEST_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await response;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async canonicalPaths(paths: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const result = await this.request("canonical_paths", paths, signal);
    const isPathList =
      Array.isArray(result) &&
      result.length === paths.length &&
      result.every((path) => typeof path === "string");
    if (!isPathList) {
      const error = new Error("Invalid reviewer canonical-path response");
      this.channel.fail(error);
      throw error;
    }
    return result;
  }

  close(): Promise<void> {
    return this.channel.close();
  }
}
