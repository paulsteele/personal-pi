import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { buildContentKey, withBuildLock } from "./tool-cache.ts";
import { publishPrivateText, readPrivateText } from "./storage.ts";
import type { ToolBuildPorts } from "./tool-provisioning.ts";
import type { ToolEngineOutput } from "./tool-build-runtime.ts";
import { consumeInspectedToolImageMounts, inspectedToolMountSchema } from "./tool-image-mounts.ts";

const probeRevision = "readonly-image-subpath-checkpoint-v2";
const sourceSubpath = "/opt/pi-mount-probe/selected";
const destination = "/opt/pi-mount-probe/destination";
const checkpointMarker = "/tmp/pi-tool-mount-checkpoint-marker";
const immutableImageId = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/);
const capabilityRecordSchema = z.strictObject({
  version: z.literal(1),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  probeRevision: z.literal(probeRevision),
});
const inspectedProbeSchema = z.looseObject({
  Id: z.string().regex(/^[a-f0-9]{64}$/),
  StaticDir: z.string(),
  Mounts: z.array(inspectedToolMountSchema),
});

export class ToolMountCapabilityError extends Error {
  constructor(
    readonly kind: "unsupported" | "unavailable",
    readonly phase: string,
    readonly backend: string,
    cause: unknown,
  ) {
    super(
      `Read-only tool image mounts ${kind} during ${phase}. Backend: ${backend}. ` +
        `Verify Podman image subpath mounts and inspect support on this backend; no copy fallback is available. ${String(cause)}`,
      { cause },
    );
    this.name = "ToolMountCapabilityError";
  }
}

function isUnsupportedMountOption(error: unknown): boolean {
  return /(?:unknown|unsupported|unrecognized|invalid).*(?:mount type|type[= ]image|subpath|rw=false)|(?:image mounts?|subpath).*(?:not supported|unsupported|not implemented)/i.test(
    String(error),
  );
}

async function verifiedImageId(
  run: ToolEngineOutput,
  imageId: string,
  signal: AbortSignal,
): Promise<string> {
  const expected = immutableImageId.parse(imageId);
  const details = z
    .array(z.looseObject({ Id: immutableImageId }))
    .length(1)
    .parse(JSON.parse(await run(["inspect", "--type", "image", expected], signal)));
  const inspectedId = details[0]!.Id;
  if (inspectedId.replace(/^sha256:/, "") !== expected.replace(/^sha256:/, "")) {
    throw new Error("Image inspection returned a different immutable identity");
  }
  return inspectedId;
}

function verifyProbeMount(output: string, artifactImageId: string): void {
  const inspection = z.array(inspectedProbeSchema).length(1).safeParse(JSON.parse(output));
  if (!inspection.success) {
    throw new Error("Container inspection does not expose verifiable image mounts", {
      cause: inspection.error,
    });
  }
  const container = inspection.data[0]!;
  const remaining = consumeInspectedToolImageMounts({
    mounts: container.Mounts,
    containerId: container.Id,
    staticDir: container.StaticDir,
    expected: [{ imageId: artifactImageId, subpath: sourceSubpath, destination }],
  });
  if (remaining.length) {
    throw new Error("Container inspection has unexpected mounts beyond the probe artifact");
  }
}

function backendDescription(version: unknown, info: unknown): string {
  return JSON.stringify({ version, info }).slice(0, 4000);
}

async function probeToolImageMounts(options: {
  builderImageId: string;
  ports: Pick<ToolBuildPorts, "build">;
  run: ToolEngineOutput;
  signal: AbortSignal;
  backend: string;
}): Promise<void> {
  const probeId = randomUUID();
  const containerName = `pi-tool-mount-probe-${probeId}`;
  const checkpointContainerName = `${containerName}-checkpoint`;
  const checkpointImageName = `localhost/pi-tool-mount-checkpoint:${probeId}`;
  const artifactName = `localhost/pi-tool-mount-probe:${probeId}`;
  const payload = `tool-mount-probe-${probeId}`;
  let checkpointImageId: string | undefined;
  let phase = "artifact construction";
  let failure: unknown;
  const run: ToolEngineOutput = (args, signal = options.signal) =>
    options.run(args, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
  try {
    const artifact = await options.ports.build(
      {
        containerfile: [
          "FROM scratch",
          `COPY payload.txt ${sourceSubpath}/payload.txt`,
          "COPY excluded.txt /opt/pi-mount-probe/excluded.txt",
          "",
        ].join("\n"),
        files: { "payload.txt": `${payload}\n`, "excluded.txt": "outside selected subpath\n" },
      },
      artifactName,
      AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]),
    );
    phase = "immutable image inspection";
    const artifactImageId = await verifiedImageId(run, artifact, options.signal);
    const builderImageId = await verifiedImageId(run, options.builderImageId, options.signal);
    phase = "image subpath mount creation";
    await run([
      "run",
      "--detach",
      "--pull=never",
      "--name",
      containerName,
      "--network=none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user",
      "0",
      "--entrypoint",
      "/bin/sh",
      "--mount",
      `type=image,source=${artifactImageId},subpath=${sourceSubpath},destination=${destination},rw=false`,
      builderImageId,
      "-c",
      "exec sleep 2147483647",
    ]);
    phase = "image mount inspection";
    try {
      verifyProbeMount(
        await run(["inspect", "--type", "container", containerName]),
        artifactImageId,
      );
    } catch (error) {
      options.signal.throwIfAborted();
      if (error instanceof SyntaxError || String(error).includes("Container inspection")) {
        throw new ToolMountCapabilityError("unsupported", phase, options.backend, error);
      }
      throw error;
    }
    phase = "subpath visibility and root write rejection";
    const verification = await run([
      "exec",
      "--user",
      "0",
      containerName,
      "sh",
      "-c",
      [
        "set -eu",
        'test "$(cat "$1/payload.txt")" = "$2"',
        'test ! -e "$1/excluded.txt"',
        'test ! -e "$1/selected"',
        `awk -v path="$1" '
$5 == path {
  for (separator=7; separator<=NF && $separator!="-"; separator++) {}
  filesystem=$(separator+1)
  superOptions=$(separator+3)

  explicitReadOnly=$6 ~ /(^|,)ro(,|$)/
  readOnlyOverlay=filesystem=="overlay" &&
    superOptions ~ /(^|,)lowerdir=/ &&
    superOptions !~ /(^|,)(upperdir|workdir)=/
  if (explicitReadOnly || readOnlyOverlay) { found=1 }
}
END { exit !found }
' /proc/self/mountinfo`,
        'if (printf corrupted > "$1/payload.txt") 2>/dev/null; then exit 41; fi',
        'if (printf created > "$1/new-file") 2>/dev/null; then exit 42; fi',
        'printf "%s\\n" "$2" > "$3"',
        'printf "readonly-subpath-verified\\n"',
      ].join("\n"),
      "sh",
      destination,
      payload,
      checkpointMarker,
    ]);
    if (verification.trim() !== "readonly-subpath-verified") {
      throw new ToolMountCapabilityError(
        "unsupported",
        phase,
        options.backend,
        "Mount behavior verification did not complete",
      );
    }
    phase = "checkpoint mount exclusion";
    const checkpoint = (
      await run(["commit", "--include-volumes=false", containerName, checkpointImageName])
    ).trim();
    checkpointImageId = await verifiedImageId(run, checkpoint, options.signal);
    const checkpointVerification = await run([
      "run",
      "--rm",
      "--pull=never",
      "--name",
      checkpointContainerName,
      "--network=none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user",
      "0",
      "--entrypoint",
      "/bin/sh",
      checkpointImageId,
      "-c",
      'set -eu; test "$(cat "$1")" = "$2"; test ! -e "$3/payload.txt"; printf "checkpoint-exclusion-verified\\n"',
      "sh",
      checkpointMarker,
      payload,
      destination,
    ]);
    if (checkpointVerification.trim() !== "checkpoint-exclusion-verified") {
      throw new ToolMountCapabilityError(
        "unsupported",
        phase,
        options.backend,
        "Checkpoint copied external mount contents or lost container-local state",
      );
    }
  } catch (error) {
    if (options.signal.aborted || error instanceof ToolMountCapabilityError) {
      failure = error;
    } else {
      const commandExitCode = (error as { code?: unknown } | undefined)?.code;
      const behaviorCheckFailed =
        typeof commandExitCode === "number" &&
        commandExitCode > 0 &&
        commandExitCode < 125 &&
        ["subpath visibility and root write rejection", "checkpoint mount exclusion"].includes(
          phase,
        );
      const kind =
        isUnsupportedMountOption(error) || behaviorCheckFailed ? "unsupported" : "unavailable";
      failure = new ToolMountCapabilityError(kind, phase, options.backend, error);
    }
  }
  const cleanupErrors: unknown[] = [];
  const cleanupArguments = [
    ["rm", "--force", "--time=0", "--ignore", checkpointContainerName, containerName],
    ["rmi", "--ignore", checkpointImageName],
    ["rmi", "--ignore", artifactName],
  ];
  for (const args of cleanupArguments) {
    try {
      await options.run(args, AbortSignal.timeout(15_000));
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      `Tool image mount probe cleanup failed. Backend: ${options.backend}`,
    );
  }
  if (failure) {
    throw failure;
  }
}

export async function requireToolImageMountCapability(options: {
  directory: string;
  builderImageId: string;
  ports: Pick<ToolBuildPorts, "build">;
  run: ToolEngineOutput;
  signal?: AbortSignal;
  report?: (text: string) => void;
}): Promise<void> {
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(240_000),
  ]);
  signal.throwIfAborted();
  let version: unknown;
  let info: unknown;
  try {
    version = JSON.parse(await options.run(["version", "--format", "json"], signal));
    info = JSON.parse(await options.run(["info", "--format", "json"], signal));
  } catch (error) {
    signal.throwIfAborted();
    throw new ToolMountCapabilityError(
      "unavailable",
      "backend discovery",
      backendDescription(version, info),
      error,
    );
  }
  const backend = backendDescription(version, info);
  const backendInfo = z
    .looseObject({
      host: z.looseObject({
        arch: z.string(),
        hostname: z.string(),
        kernel: z.string(),
        os: z.string(),
        remoteSocket: z.unknown().optional(),
        security: z.unknown().optional(),
      }),
      store: z.looseObject({
        graphRoot: z.string(),
        runRoot: z.string(),
        graphDriverName: z.string(),
        graphOptions: z.unknown().optional(),
        configFile: z.string().optional(),
        transientStore: z.boolean().optional(),
      }),
    })
    .parse(info);
  const { arch, hostname, kernel, os, remoteSocket, security } = backendInfo.host;
  const { graphRoot, runRoot, graphDriverName, graphOptions, configFile, transientStore } =
    backendInfo.store;
  const key = buildContentKey({
    version,
    builderImageId: options.builderImageId,
    probeRevision,
    host: { arch, hostname, kernel, os, remoteSocket, security },
    store: { graphRoot, runRoot, graphDriverName, graphOptions, configFile, transientStore },
  });
  const path = join(options.directory, "capabilities", `image-mount-${key}.json`);
  await withBuildLock(`${path}.build.lock`, signal, async () => {
    const stored = await readPrivateText(path);
    if (stored) {
      const record = capabilityRecordSchema.parse(JSON.parse(stored.text));
      if (record.key !== key) {
        throw new Error("Tool image mount capability record has a different backend identity");
      }
      options.report?.("Reusing verified read-only tool image mount capability");
      return;
    }
    options.report?.("Verifying read-only tool image subpath mounts and checkpoint exclusion");
    await probeToolImageMounts({ ...options, signal, backend });
    await publishPrivateText(
      path,
      JSON.stringify({ version: 1, key, probeRevision }),
      undefined,
      signal,
    );
  });
}
