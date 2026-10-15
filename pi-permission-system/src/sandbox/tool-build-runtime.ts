import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { authorizeEngineArguments, type EngineAuthority } from "./engine-policy.ts";
import { imageDetailsSchema, validateImageIsolation } from "./metadata-policy.ts";
import { buildContentKey, withBuildLock } from "./tool-cache.ts";
import { toolBuilderReference } from "./tool-builders.ts";
import { resolveToolPlatform, type ToolPlatform } from "./tool-platform.ts";
import { ensurePrivateDirectory, publishPrivateText, readPrivateText } from "./storage.ts";
import { fingerprintBuildContext } from "./build-context.ts";
import type { GeneratedImageRecipe } from "./tool-assembly.ts";
import type { ToolBuildPorts, ToolInventory } from "./tool-provisioning.ts";
import type { ToolImageMount } from "./tool-image-mounts.ts";

export type ToolEngineOutput = (args: string[], signal?: AbortSignal) => Promise<string>;

async function inspectImage(run: ToolEngineOutput, image: string, signal?: AbortSignal) {
  return imageDetailsSchema.parse(
    JSON.parse(await run(["inspect", "--type", "image", image], signal))[0],
  );
}

async function writeBuildInput(path: string, content: string, signal?: AbortSignal): Promise<void> {
  await withBuildLock(`${path}.build.lock`, signal, async () => {
    const stored = await readPrivateText(path);
    if (stored?.text === content) {
      return;
    }
    if (stored) {
      throw new Error(`Immutable generated build input changed: ${path}`);
    }
    await ensurePrivateDirectory(dirname(path));
    await publishPrivateText(path, content, undefined, signal);
  });
}

export function createToolBuildPorts(options: {
  directory: string;
  run: ToolEngineOutput;
  approvedMountArguments: readonly string[];
}): ToolBuildPorts {
  const inspect = async (imageId: string, signal?: AbortSignal) => {
    try {
      return (await inspectImage(options.run, imageId, signal)).Id;
    } catch (error) {
      signal?.throwIfAborted();
      if (/no such image|image not known|does not exist/i.test(String(error))) {
        return undefined;
      }
      throw error;
    }
  };
  return {
    inspect,
    async validateImage(imageId, signal) {
      validateImageIsolation(
        await inspectImage(options.run, imageId, signal),
        options.approvedMountArguments,
      );
    },
    async resolveBuilder(platform, signal) {
      const reference = toolBuilderReference(platform);
      const cached = await inspect(reference, signal);
      if (cached) {
        return cached;
      }
      await options.run(["pull", reference], signal);
      return (await inspectImage(options.run, reference, signal)).Id;
    },
    async build(recipe: GeneratedImageRecipe, imageName, signal) {
      signal?.throwIfAborted();
      const directory = join(options.directory, "contexts", buildContentKey(recipe));
      return withBuildLock(`${directory}.build.lock`, signal, async () => {
        await ensurePrivateDirectory(directory);
        for (const [path, content] of Object.entries(recipe.files)) {
          if (
            path.includes("\\") ||
            path.includes("\0") ||
            path.split("/").some((part) => !part || part === "." || part === "..")
          ) {
            throw new Error("Generated build input escaped its context");
          }
          await writeBuildInput(join(directory, path), content, signal);
        }
        const containerfile = join(directory, "Containerfile");
        await writeBuildInput(containerfile, recipe.containerfile, signal);
        const fingerprint = await fingerprintBuildContext(directory, signal);
        const authority: EngineAuthority = {
          label: "pi.sandbox.tool-build=true",
          containerName: "pi-tool-build",
          containerLabels: {},
          containers: [],
          images: [],
          imageNames: [imageName],
          contexts: [directory],
          containerfiles: [containerfile],
          mounts: [],
          volumes: [],
          ports: [],
          environment: {},
          users: [],
        };
        const args = authorizeEngineArguments(
          ["build", "--layers", "-f", containerfile, "-t", imageName, directory],
          directory,
          authority,
        );
        await options.run(args, signal);
        if ((await fingerprintBuildContext(directory, signal)) !== fingerprint) {
          throw new Error("Tool build inputs changed during build");
        }
        return (await inspectImage(options.run, imageName, signal)).Id;
      });
    },
  };
}

export async function inspectToolPlatform(options: {
  run: ToolEngineOutput;
  imageId: string;
  signal?: AbortSignal;
  approvedMountArguments?: readonly string[];
}): Promise<ToolPlatform> {
  const { run, imageId, signal, approvedMountArguments = [] } = options;
  const rawDetails = JSON.parse(await run(["inspect", "--type", "image", imageId], signal))[0];
  const image = imageDetailsSchema.parse(rawDetails);
  validateImageIsolation(image, approvedMountArguments);
  if (typeof image.Os !== "string" || typeof image.Architecture !== "string") {
    throw new Error("Image inspection omitted its platform");
  }
  const name = `pi-tool-platform-${randomUUID()}`;
  let output: string;
  try {
    output = await run(
      [
        "run",
        "--rm",
        "--name",
        name,
        "--network=none",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--entrypoint",
        "/bin/sh",
        imageId,
        "-c",
        'cat /etc/os-release; if ls /lib/ld-musl-*.so.1 >/dev/null 2>&1; then printf "\\nPI_LIBC=musl\\n"; else printf "\\nPI_LIBC=glibc\\n"; fi',
      ],
      signal,
    );
  } finally {
    await run(["rm", "--force", name]).catch(() => {});
  }
  const fields = new Map(
    output.split("\n").map((line) => {
      const separator = line.indexOf("=");
      const fieldName = separator < 0 ? "" : line.slice(0, separator);
      const fieldValue = line.slice(separator + 1).replace(/^"|"$/g, "");
      return [fieldName, fieldValue];
    }),
  );
  return resolveToolPlatform({
    os: image.Os,
    architecture: image.Architecture,
    distribution: fields.get("ID") ?? "",
    release: fields.get("VERSION_ID") ?? "",
    libc: fields.get("PI_LIBC") ?? "",
  });
}

export async function verifyRuntimeInventory(options: {
  run: ToolEngineOutput;
  container: string;
  user: string;
  inventory: ToolInventory;
  toolImageMounts?: readonly ToolImageMount[];
  remoteEnvironment?: Record<string, string>;
  workspace?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const execArguments = (workdir: string | undefined) => [
    "exec",
    "--user",
    options.user,
    ...Object.entries(options.remoteEnvironment ?? {}).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
    ...(workdir ? ["--workdir", workdir] : []),
    options.container,
  ];
  const execContextArguments = execArguments(options.workspace);
  // Version probes verify the provisioned binary itself, so they must not resolve
  // project-pinned toolchains (for example a global.json requesting another .NET SDK).
  const projectNeutralExecArguments = execArguments("/");
  if (options.toolImageMounts?.length) {
    const readOnlyMountsScript = `
set -eu
for destination do
  awk -v destination="$destination" '
    $5 == destination {
      for (separator=7; separator<=NF && $separator!="-"; separator++) {}
      filesystem=$(separator+1)
      superOptions=$(separator+3)

      explicitReadOnly=$6 ~ /(^|,)ro(,|$)/
      readOnlyOverlay=filesystem=="overlay" &&
        superOptions ~ /(^|,)lowerdir=/ &&
        superOptions !~ /(^|,)(upperdir|workdir)=/
      if (explicitReadOnly || readOnlyOverlay) { foundReadOnlyMount=1 }
    }
    END { exit !foundReadOnlyMount }
  ' /proc/self/mountinfo
done
`;
    await options.run(
      [
        ...execContextArguments,
        "sh",
        "-c",
        readOnlyMountsScript,
        "sh",
        ...options.toolImageMounts.map((mount) => mount.destination),
      ],
      options.signal,
    );
  }
  const executables = options.inventory.tools.map((tool) => tool.executable);
  if (executables.length) {
    const verifyExecutablesScript = [
      "set -eu",
      "for executable do",
      '  if ! command -v "$executable" >/dev/null; then',
      '    printf "Provisioned executable unavailable: %s\\n" "$executable" >&2',
      "    exit 1",
      "  fi",
      "done",
    ].join("\n");
    await options.run(
      [...execContextArguments, "sh", "-c", verifyExecutablesScript, "sh", ...executables],
      options.signal,
    );
  }
  for (const tool of options.inventory.tools) {
    if (tool.id === "jscpd") {
      const versionOutput = await options.run(
        [...projectNeutralExecArguments, tool.executable, "--version"],
        options.signal,
      );
      const escapedVersion = tool.version.replaceAll(".", "\\.");
      const versionPattern = new RegExp(`(?:^|\\s)${escapedVersion}(?:\\s|$)`);
      if (!versionPattern.test(versionOutput.trim())) {
        throw new Error(`Provisioned jscpd version mismatch: expected ${tool.version}`);
      }
    }
    const isRuntimeTool = tool.id.endsWith("-runtime");
    if (isRuntimeTool) {
      const versionArgument = tool.id === "go-runtime" ? "version" : "--version";
      await options.run(
        [...projectNeutralExecArguments, tool.executable, versionArgument],
        options.signal,
      );
    }
  }
}
