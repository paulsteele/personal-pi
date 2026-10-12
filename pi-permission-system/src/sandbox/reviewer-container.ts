import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isPathInside } from "./storage.ts";
import { podmanOutput } from "./driver.ts";
import { cliHostEnvironment } from "./devcontainer-cli.ts";
import { validateCreatedContainer } from "./container-validation.ts";
import { mountArgument, validateMountIdentity, type MountGrant } from "./mounts.ts";
import type { SandboxSession } from "./session.ts";
import { ReviewerFilesystemTransport } from "./reviewer-transport.ts";

export interface ReviewerContainer {
  readonly container: string;
  readonly mounts: readonly MountGrant[];
  canonicalPaths(paths: readonly string[], signal?: AbortSignal): Promise<string[]>;
  close(): Promise<void>;
}

export async function createReviewerContainer(options: {
  session: SandboxSession;
  operationId: string;
  taskId: string;
  signal: AbortSignal;
}): Promise<ReviewerContainer> {
  options.signal.throwIfAborted();
  const revision = options.session.revision;
  const environment = options.session.environment;
  const privateReviewStorage = join(options.session.options.agentDir, "extensions", "pr-review");
  const privateSandboxStorage = join(
    options.session.options.agentDir,
    "extensions",
    "pi-permission-system",
  );
  const mounts = options.session.mounts
    .filter((mount) => {
      const overlapsPrivateRuntime = [privateReviewStorage, privateSandboxStorage].some(
        (storage) => isPathInside(storage, mount.source) || isPathInside(mount.source, storage),
      );
      return !overlapsPrivateRuntime;
    })
    .map((mount) => ({ ...mount, access: "ro" as const }));
  for (const mount of mounts) {
    await validateMountIdentity(mount);
  }
  const containerName = `pi-reviewer-${randomUUID()}`;
  const runArguments = [
    "run",
    "--detach",
    "--pull=never",
    "--read-only",
    "--read-only-tmpfs=false",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--network=none",
    "--no-hosts",
    "--pids-limit=64",
    "--memory=256m",
    "--cpus=1",
    "--name",
    containerName,
    "--label",
    `pi.sandbox.session=${options.session.options.sessionId}`,
    "--label",
    "pi.sandbox.role=reviewer",
    "--label",
    `pi.sandbox.review-operation=${options.operationId}`,
    "--label",
    `pi.sandbox.review-task=${options.taskId}`,
    "--user",
    environment.user,
    "--workdir",
    environment.workspace,
    ...mounts.flatMap((mount) => ["--mount", mountArgument(mount)]),
    "--entrypoint",
    "python3",
    environment.image,
    "-I",
    "-u",
    "-c",
    "import time; time.sleep(2147483647)",
  ];
  let transport: ReviewerFilesystemTransport | undefined;
  let closing: Promise<void> | undefined;
  const removeContainer = async () => {
    const removalTimeoutMs = 15_000;
    try {
      await podmanOutput(
        ["rm", "--force", "--time=0", "--ignore", containerName],
        undefined,
        undefined,
        removalTimeoutMs,
      );
    } catch (error) {
      const removalError = error as Error & {
        stderr?: string;
        code?: string | number;
        signal?: string;
        killed?: boolean;
      };
      const removalDiagnostics = [
        removalError.stderr?.trim(),
        removalError.killed
          ? `Removal command terminated (timeout budget ${removalTimeoutMs}ms)`
          : undefined,
        removalError.signal ? `Signal: ${removalError.signal}` : undefined,
        removalError.code !== undefined ? `Exit code: ${removalError.code}` : undefined,
      ]
        .filter(Boolean)
        .join("; ");
      throw new Error(
        `Reviewer container removal failed: ${containerName}. ${removalDiagnostics || removalError.message}`,
        { cause: error },
      );
    }
  };
  const close = () => {
    closing ??= (async () => {
      let transportError: unknown;
      try {
        await transport?.close();
      } catch (error) {
        transportError = error;
      }
      try {
        await removeContainer();
      } catch (removalError) {
        if (transportError) {
          throw new AggregateError(
            [transportError, removalError],
            `Reviewer transport and container cleanup failed: ${containerName}`,
          );
        }
        throw removalError;
      }
      if (transportError) {
        throw transportError;
      }
    })();
    return closing;
  };
  try {
    const container = (await podmanOutput(runArguments, options.signal)).trim();
    if (!/^[a-f0-9]{64}$/.test(container)) {
      throw new Error("Invalid reviewer container identity");
    }
    const details = JSON.parse(await podmanOutput(["inspect", container], options.signal))[0];
    validateCreatedContainer(details, options.session.options.sessionId, mounts);
    const hasExpectedIsolation =
      details.Id === container &&
      details.Image === environment.image &&
      details.HostConfig.ReadonlyRootfs === true &&
      details.HostConfig.NetworkMode === "none" &&
      details.Config.Labels["pi.sandbox.role"] === "reviewer" &&
      details.Config.Labels["pi.sandbox.review-operation"] === options.operationId &&
      details.Config.Labels["pi.sandbox.review-task"] === options.taskId;
    if (!hasExpectedIsolation) {
      throw new Error("Reviewer container does not meet read-only isolation requirements");
    }
    for (const mount of mounts) {
      await validateMountIdentity(mount);
    }
    options.signal.throwIfAborted();
    if (revision !== options.session.revision) {
      throw new Error("Sandbox changed during reviewer container creation");
    }
    const script = await readFile(new URL("./reviewer-filesystem.py", import.meta.url), "utf8");
    transport = new ReviewerFilesystemTransport({
      args: [
        "exec",
        "-i",
        "--user",
        environment.user,
        "--workdir",
        environment.workspace,
        container,
        "python3",
        "-I",
        "-u",
        "-c",
        script,
      ],
      env: cliHostEnvironment(),
      signal: options.signal,
    });
    if ((await transport.request("ready")) !== true) {
      throw new Error("Reviewer filesystem transport did not become ready");
    }
    return {
      container,
      mounts,
      canonicalPaths: (paths, signal) => transport!.canonicalPaths(paths, signal),
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Reviewer startup and cleanup failed: ${containerName}`,
      );
    }
    throw error;
  }
}
