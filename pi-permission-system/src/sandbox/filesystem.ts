import { readFile } from "node:fs/promises";
import type { PreparedEnvironment } from "./driver.ts";
import { runGuestProcess } from "./process.ts";

export interface GuestFileMetadata {
  directory: boolean;
  file: boolean;
  size: number;
  identity: string;
}

export class GuestFilesystem {
  constructor(
    private readonly environment: () => PreparedEnvironment,
    private readonly execute: typeof runGuestProcess = runGuestProcess,
  ) {}

  private async request(
    operation: string,
    path: string,
    operationParameters: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const environment = this.environment();
    const needsExtendedTimeout =
      operation === "canonical" || operation === "canonical_paths" || operation === "entries_exist";
    const script = await readFile(new URL("./guest-filesystem.py", import.meta.url), "utf8");
    const result = await this.execute({
      container: environment.container,
      user: environment.user,
      cwd: environment.workspace,
      environment: environment.remoteEnvironment,
      command: ["python3", "-c", script],
      input: Buffer.from(
        JSON.stringify({ operation, path, cwd: environment.workspace, ...operationParameters }),
      ),
      signal,
      timeoutMs: needsExtendedTimeout ? 10_000 : undefined,
    });
    if (result.code !== 0) {
      throw new Error(`Guest ${operation} failed for ${path}: ${result.stderr}`);
    }
    return JSON.parse(result.output.toString());
  }

  async canonical(path: string, signal?: AbortSignal): Promise<string> {
    return (await this.request("canonical", path, {}, signal)) as string;
  }
  async canonicalPaths(paths: readonly string[], signal?: AbortSignal): Promise<string[]> {
    return (await this.request("canonical_paths", ".", { paths }, signal)) as string[];
  }
  async entriesExist(paths: readonly string[], signal?: AbortSignal): Promise<boolean[]> {
    return (await this.request("entries_exist", ".", { paths }, signal)) as boolean[];
  }
  async read(path: string, signal?: AbortSignal): Promise<Buffer> {
    return Buffer.from((await this.request("read", path, {}, signal)) as string, "base64");
  }
  async write(path: string, content: Buffer | string, signal?: AbortSignal): Promise<void> {
    await this.request("write", path, { content: Buffer.from(content).toString("base64") }, signal);
  }
  async mkdir(path: string, signal?: AbortSignal): Promise<void> {
    await this.request("mkdir", path, {}, signal);
  }
  async stat(path: string, signal?: AbortSignal): Promise<GuestFileMetadata> {
    return (await this.request("stat", path, {}, signal)) as GuestFileMetadata;
  }
  async list(path: string, signal?: AbortSignal): Promise<string[]> {
    return (await this.request("list", path, {}, signal)) as string[];
  }
  async access(path: string, signal?: AbortSignal): Promise<void> {
    await this.request("access", path, {}, signal);
  }
  async mime(path: string, signal?: AbortSignal): Promise<string | null> {
    return (await this.request("mime", path, {}, signal)) as string | null;
  }
  async glob(
    pattern: string,
    path: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return (await this.request("glob", path, { pattern, limit }, signal)) as string[];
  }
}
