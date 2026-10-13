import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { PreparedEnvironment } from "./driver.ts";
import { guestToHost, type MountGrant } from "./mounts.ts";
import { runGuestProcess } from "./process.ts";
import { awaitSandboxWork } from "./cancellation.ts";

export interface GuestFileMetadata {
  directory: boolean;
  file: boolean;
  size: number;
  identity: string;
}

interface GuestReadAccess {
  path: string;
  exists: boolean;
  readable: boolean;
}

type HostPathStatus =
  | { exists: true; kind: "file" | "directory" | "other" }
  | { exists: false }
  | { exists: "unknown"; errorCode: string };

interface GuestFilesystemOptions {
  mounts?: () => readonly MountGrant[];
  statHostPath?: (path: string) => Promise<Pick<Stats, "isFile" | "isDirectory">>;
}

export class GuestFilesystem {
  constructor(
    private readonly environment: () => PreparedEnvironment,
    private readonly execute: typeof runGuestProcess = runGuestProcess,
    private readonly options: GuestFilesystemOptions = {},
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
  private async inspectHostPath(path: string, signal?: AbortSignal): Promise<HostPathStatus> {
    const deadline = AbortSignal.timeout(2000);
    const lookupSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const metadata = await awaitSandboxWork(
        (this.options.statHostPath ?? stat)(path),
        lookupSignal,
      );
      if (metadata.isFile()) {
        return { exists: true, kind: "file" };
      }
      if (metadata.isDirectory()) {
        return { exists: true, kind: "directory" };
      }
      return { exists: true, kind: "other" };
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline.aborted) {
        return { exists: "unknown", errorCode: "ETIMEDOUT" };
      }
      const errorCode =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "UNKNOWN";
      if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
        return { exists: false };
      }
      return { exists: "unknown", errorCode };
    }
  }

  private mountRecoveryGuidance(
    guestPath: string,
    hostPath: string,
    coveredByApprovedMount: boolean,
    hostStatus: HostPathStatus,
  ): string {
    const requestInstructions =
      'For an unmounted host file or directory, call request_host_mount with its absolute host path, access: "ro", and a reason. After human approval, retry using the returned destination. Approval restarts container processes.';
    if (coveredByApprovedMount) {
      return `This path is already covered by an approved mount; check guest permissions or a missing path rather than requesting the same mount again. ${requestInstructions}`;
    }
    if (hostStatus.exists === false) {
      return `The checked host path does not exist; correct the path first. ${requestInstructions}`;
    }
    if (hostStatus.exists === "unknown" || hostStatus.kind === "other") {
      return `Verify that the host path is an existing regular file or directory first. ${requestInstructions}`;
    }
    const mountRequest = {
      path: hostPath,
      destination: guestPath,
      access: "ro",
      reason: "Read the requested host file or directory from the sandbox",
    };
    return `If you intended to read this host path, call request_host_mount with ${JSON.stringify(mountRequest)}. After human approval, retry using the returned destination. Approval restarts container processes.`;
  }

  async access(path: string, signal?: AbortSignal): Promise<void> {
    const guestAccess = (await this.request("access", path, {}, signal)) as GuestReadAccess;
    if (guestAccess.readable) {
      return;
    }
    signal?.throwIfAborted();
    const mountedHostPath = guestToHost(guestAccess.path, this.options.mounts?.() ?? []);
    const hostPath = mountedHostPath ?? guestAccess.path;
    const hostStatus = await this.inspectHostPath(hostPath, signal);
    signal?.throwIfAborted();
    const coveredByApprovedMount = mountedHostPath !== undefined;
    const error = new Error(
      [
        `Guest access failed for ${path}`,
        `Guest status: ${JSON.stringify(guestAccess)}`,
        `Host path checked: ${hostPath}`,
        `Host status: ${JSON.stringify(hostStatus)}`,
        `Covered by approved mount: ${coveredByApprovedMount}`,
        this.mountRecoveryGuidance(guestAccess.path, hostPath, coveredByApprovedMount, hostStatus),
      ].join("\n"),
    );
    error.name = "PermissionError";
    throw error;
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
