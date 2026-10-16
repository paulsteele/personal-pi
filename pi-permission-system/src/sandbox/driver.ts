import { execFile } from "node:child_process";
import { StartupBuildOutput } from "./build-output.ts";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cliHostEnvironment, runDevcontainerCli } from "./devcontainer-cli.ts";
import { fingerprintBuildContext } from "./build-context.ts";
import { type ResolvedDefinition, validateHostEnvironmentImports } from "./definition.ts";
import { readPrivateText } from "./storage.ts";
import { startEngineAdapter } from "./engine-server.ts";
import { type EngineAuthority } from "./engine-policy.ts";
import { containerIdentity } from "./container-identity.ts";
import { validateCreatedContainer } from "./container-validation.ts";
import { imageDetailsSchema, validateImageIsolation } from "./metadata-policy.ts";
import { type MountGrant, mountArgument } from "./mounts.ts";
import { ensureProjectVolume, volumeMountArgument, type VolumeGrant } from "./volumes.ts";
import { devcontainerPorts } from "./ports.ts";
import { canonicalPath, ensurePrivateDirectory, sha256Hex } from "./storage.ts";
import { provisionEnvironmentImage, type ToolInventory } from "./tool-provisioning.ts";
import {
  createToolBuildPorts,
  inspectToolPlatform,
  verifyRuntimeInventory,
} from "./tool-build-runtime.ts";
import { authorizeBuildInputs } from "./build-inputs.ts";
import { requireToolImageMountCapability } from "./tool-mount-capability.ts";
import {
  toolImageMountsSchema,
  SavedToolArtifactUnavailableError,
  validateToolImageInventory,
  verifyToolMountDestinations,
  type ToolImageMount,
} from "./tool-image-mounts.ts";
import { randomUUID } from "node:crypto";
import type { ToolEngineOutput } from "./tool-build-runtime.ts";
import type { ImageDetails } from "./metadata-policy.ts";

const execute = promisify(execFile);

export async function podmanOutput(
  args: string[],
  signal?: AbortSignal,
  progress?: (text: string) => void,
  timeoutMs = 120_000,
  diagnostic?: (text: string) => void,
): Promise<string> {
  const execution = execute("podman", args, {
    env: cliHostEnvironment(),
    signal,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  execution.child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    progress?.(text);
    diagnostic?.(`podman ${args[0]} stdout: ${text}`);
  });
  execution.child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    progress?.(text);
    diagnostic?.(`podman ${args[0]} stderr: ${text}`);
  });
  return (await execution).stdout;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function verifySavedToolArtifact(
  mount: ToolImageMount,
  run: ToolEngineOutput,
  signal?: AbortSignal,
): Promise<void> {
  let artifact: ImageDetails;
  try {
    const inspectionOutput = await run(["inspect", "--type", "image", mount.imageId], signal);
    const inspectedImages = JSON.parse(inspectionOutput) as unknown[];
    artifact = imageDetailsSchema.parse(inspectedImages[0]);
  } catch (error) {
    signal?.throwIfAborted();
    throw new SavedToolArtifactUnavailableError(mount, error);
  }
  if (artifact.Id !== mount.imageId) {
    throw new Error(`Tool artifact inspection returned a different identity: ${mount.toolId}`);
  }
  validateImageIsolation(artifact);
}

export interface PreparedEnvironment {
  container: string;
  image: string;
  user: string;
  workspace: string;
  configuration: Record<string, unknown>;
  remoteEnvironment?: Record<string, string>;
  toolInventory?: ToolInventory;
  toolImageMounts?: ToolImageMount[];
}

export async function createDevcontainer(options: {
  resolved: ResolvedDefinition;
  mounts: MountGrant[];
  volumes: readonly VolumeGrant[];
  sessionId: string;
  directory: string;
  privateStorage: string;
  hostEnvironment: string[];
  confirmHostInitialization: (preview: string) => Promise<boolean>;
  signal?: AbortSignal;
  previousContainer?: string;
  checkpointImage?: string;
  generation?: number;
  progress?: (text: string) => void;
  stage?: (text: string) => void;
  diagnostic?: (text: string) => void;
  buildTimeoutMs?: number;
  startupTimeoutMs?: number;
  cacheDirectory?: string;
  checkpointInventory?: ToolInventory;
  checkpointToolImageMounts?: ToolImageMount[];
}): Promise<PreparedEnvironment> {
  const stage = (text: string) => {
    if (options.stage) {
      options.stage(text);
    } else {
      options.progress?.(`${text}\n`);
    }
  };
  const toolEngine = async (args: string[], signal?: AbortSignal) => {
    const isImageBuild = args[0] === "build";
    const timeoutMs = isImageBuild ? (options.buildTimeoutMs ?? 1_800_000) : 120_000;
    const isVisibleOperation = isImageBuild || args[0] === "pull";
    const buildOutput =
      isImageBuild && options.progress ? new StartupBuildOutput(options.progress) : undefined;
    try {
      return await podmanOutput(
        args,
        signal,
        buildOutput
          ? (text) => buildOutput.write(text)
          : isVisibleOperation
            ? options.progress
            : undefined,
        timeoutMs,
        options.diagnostic,
      );
    } finally {
      buildOutput?.finish();
    }
  };
  stage("Preparing devcontainer configuration…");
  await authorizeBuildInputs({
    projectRoot: options.resolved.project.root,
    definitionPath: options.resolved.path,
    containerfile: options.resolved.containerfile,
    buildContext: options.resolved.buildContext,
    privateStorage: options.privateStorage,
    confirm: options.confirmHostInitialization,
    signal: options.signal,
  });
  await ensurePrivateDirectory(options.directory);
  const identity = containerIdentity({
    projectRoot: options.resolved.project.root,
    startupDirectory: options.resolved.startupDirectory,
    sessionId: options.sessionId,
    generation: options.generation ?? 1,
  });
  const label = `pi.sandbox.session=${options.sessionId}`;
  const snapshot = join(options.directory, "devcontainer.json");
  const definition = { ...options.resolved.definition };
  if (definition.initializeCommand) {
    const preview = `Host initialization exception\nCwd: ${options.resolved.startupDirectory}\nEnvironment imports: ${options.hostEnvironment.join(", ")}\n${JSON.stringify(definition.initializeCommand)}`;
    if (!(await options.confirmHostInitialization(preview))) {
      throw new Error("Host initialization was not approved");
    }
    options.signal?.throwIfAborted();
  }
  if (definition.build) {
    definition.build = {
      ...definition.build,
      dockerfile: options.resolved.containerfile!,
      context: options.resolved.buildContext,
    };
  }
  if (definition.dockerFile) {
    definition.dockerFile = options.resolved.containerfile;
    definition.context = options.resolved.buildContext;
  }
  const workspaceMount = options.mounts[0];
  definition.workspaceFolder ??= workspaceMount.destination;
  definition.workspaceMount = mountArgument(workspaceMount);
  const volumeMountArguments = options.volumes.map(volumeMountArgument);
  const approvedMountArguments = [...options.mounts.map(mountArgument), ...volumeMountArguments];
  definition.mounts = [...options.mounts.slice(1).map(mountArgument), ...volumeMountArguments];
  const imageName = `localhost/pi-sandbox-${sha256Hex(options.sessionId).slice(0, 20)}`;
  const authority: EngineAuthority = {
    label,
    containerName: identity.name,
    containerLabels: identity.labels,
    containers: options.previousContainer ? [options.previousContainer] : [],
    images: [],
    imageNames: [
      imageName,
      ...(definition.image ? [definition.image] : []),
      ...(options.checkpointImage ? [options.checkpointImage] : []),
    ],
    contexts: options.resolved.buildContext ? [options.resolved.buildContext] : [],
    containerfiles: options.resolved.containerfile ? [options.resolved.containerfile] : [],
    mounts: options.mounts,
    volumes: volumeMountArguments,
    ports: devcontainerPorts([].concat((definition.appPort as never) ?? [])),
    environment: definition.containerEnv ?? {},
    users: [
      definition.containerUser ?? "root",
      definition.remoteUser ?? definition.containerUser ?? "root",
    ],
  };
  const fingerprintResolvedBuildContext = (buildContext: string) =>
    fingerprintBuildContext(buildContext, options.signal, options.resolved.containerfile);
  const contextFingerprint = options.resolved.buildContext
    ? await fingerprintResolvedBuildContext(options.resolved.buildContext)
    : undefined;
  if (options.resolved.containerfile) {
    const containerfileText = (await readPrivateText(options.resolved.containerfile))?.text ?? "";
    const baseImageMatches = containerfileText.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/gim);
    const baseImageReferences = [...baseImageMatches].map((match) => match[1]);
    if (baseImageReferences.some((image) => image.includes("$"))) {
      throw new Error(
        "Parameterized Containerfile base images require an explicit resolved recipe",
      );
    }
    authority.imageNames.push(...baseImageReferences);
  }
  const socketDirectory = await mkdtemp(join(tmpdir(), "pi-engine-"));
  await chmod(socketDirectory, 0o700);
  const adapter = await startEngineAdapter({
    socketPath: join(socketDirectory, "engine.sock"),
    authority,
    authorizeBuildRecipe: async (args, cwd) => {
      const fileIndex = args.findIndex((arg) => arg === "-f" || arg === "--file");
      const file = fileIndex >= 0 ? resolve(cwd, args[fileIndex + 1]) : undefined;
      if (!file || authority.containerfiles.includes(file)) {
        return;
      }
      if (!file.endsWith("/Dockerfile-with-features") || !options.resolved.containerfile) {
        throw new Error("Unverified generated devcontainer build recipe");
      }
      const generated = await readPrivateText(await canonicalPath(file));
      const original = await readPrivateText(options.resolved.containerfile);
      if (!generated || !original) {
        throw new Error("Unverified generated devcontainer build recipe");
      }
      const originalWithFeatureStage = original.text.replace(
        /^(FROM[^\n]+)$/m,
        "$1 AS dev_container_auto_added_stage_label",
      );
      const containsOriginalRecipe = generated.text.includes(originalWithFeatureStage);
      if (!containsOriginalRecipe) {
        throw new Error("Unverified generated devcontainer build recipe");
      }
      authority.containerfiles.push(file);
    },
    authorizeContainerInspection: async (id) => {
      if (!/^[a-f0-9]{12,64}$/.test(id)) {
        throw new Error("Invalid session container ID");
      }
      const details = JSON.parse(await toolEngine(["inspect", id], options.signal))[0];
      if (details?.Config?.Labels?.["pi.sandbox.session"] !== options.sessionId) {
        throw new Error("Container inspection targets another session");
      }
      authority.containers.push(id, details.Id);
    },
    beforeRun: async (image) => {
      const details = imageDetailsSchema.parse(
        JSON.parse(await toolEngine(["inspect", "--type", "image", image], options.signal))[0],
      );
      validateHostEnvironmentImports(
        details.Config.Labels?.["devcontainer.metadata"] ?? "",
        options.hostEnvironment,
      );
      validateImageIsolation(details, approvedMountArguments);
      authority.images.push(details.Id);
      authority.users = [...new Set([...authority.users, details.Config.User || "root"])];
      if (
        options.resolved.buildContext &&
        (await fingerprintResolvedBuildContext(options.resolved.buildContext)) !==
          contextFingerprint
      ) {
        throw new Error("Build context changed during environment creation");
      }
    },
    afterOperation: async (args, output) => {
      if (args[0] === "build") {
        const image = imageDetailsSchema.parse(
          JSON.parse(
            await toolEngine(["inspect", "--type", "image", imageName], options.signal),
          )[0],
        );
        authority.images.push(image.Id);
      }
      if (args[0] === "ps") {
        for (const id of output
          .trim()
          .split(/\s+/)
          .filter((value) => /^[a-f0-9]{12,64}$/.test(value))) {
          const details = JSON.parse(await toolEngine(["inspect", id], options.signal))[0];
          if (details?.Config?.Labels?.["pi.sandbox.session"] === options.sessionId) {
            authority.containers.push(id, details.Id);
          }
        }
      }
    },
  });
  const adapterPath = join(options.directory, "podman-adapter");
  await writeFile(
    adapterPath,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL("./engine-adapter.mjs", import.meta.url)))} "$@"\n`,
    { mode: 0o700 },
  );
  await chmod(adapterPath, 0o700);
  const common = [
    "--workspace-folder",
    options.resolved.startupDirectory,
    "--config",
    options.resolved.path,
    "--override-config",
    snapshot,
    "--docker-path",
    adapterPath,
    "--mount-workspace-git-root",
    "false",
    "--mount-git-worktree-common-dir",
    "false",
    "--id-label",
    label,
    "--id-label",
    `pi.sandbox.generation=${options.generation ?? 1}`,
    "--user-data-folder",
    join(options.directory, "cli"),
  ];
  const run = async (args: string[]) => {
    const isBuild = args[0] === "build";
    const buildOutput =
      isBuild && options.progress ? new StartupBuildOutput(options.progress) : undefined;
    try {
      return await runDevcontainerCli({
        args,
        cwd: options.resolved.startupDirectory,
        env: { ...cliHostEnvironment(options.hostEnvironment), ...adapter.environment },
        signal: options.signal,
        progress: buildOutput ? (text) => buildOutput.write(text) : options.progress,
        diagnostic: options.diagnostic,
        timeoutMs: isBuild ? options.buildTimeoutMs : options.startupTimeoutMs,
      });
    } finally {
      buildOutput?.finish();
    }
  };
  let toolInventory = options.checkpointInventory;
  let toolImageMounts = options.checkpointToolImageMounts;
  let createdContainer: string | undefined;
  try {
    if (toolImageMounts !== undefined) {
      toolImageMounts = toolImageMountsSchema.parse(toolImageMounts);
      if (!toolInventory) {
        throw new Error("Mounted tools require their saved tool inventory");
      }
      validateToolImageInventory(toolImageMounts, toolInventory);
      for (const mount of toolImageMounts) {
        await verifySavedToolArtifact(mount, toolEngine, options.signal);
      }
    }
    if (options.checkpointImage) {
      delete definition.build;
      delete definition.dockerFile;
      delete definition.context;
      definition.image = options.checkpointImage;
    }
    await writeFile(snapshot, JSON.stringify(definition), { mode: 0o600 });
    if (definition.build || definition.dockerFile) {
      const baseBuildDefinition = definition.build
        ? { build: definition.build }
        : { dockerFile: definition.dockerFile, context: definition.context };
      await writeFile(snapshot, JSON.stringify(baseBuildDefinition), { mode: 0o600 });
      stage("Checking cached development image build…");
      await run([
        "build",
        "--workspace-folder",
        options.resolved.startupDirectory,
        "--config",
        snapshot,
        "--docker-path",
        adapterPath,
        "--image-name",
        imageName,
        "--buildkit",
        "never",
        "--no-lockfile",
      ]);
      delete definition.build;
      delete definition.dockerFile;
      delete definition.context;
      definition.image = imageName;
      await writeFile(snapshot, JSON.stringify(definition), { mode: 0o600 });
    }
    stage("Validating development image…");
    let image;
    try {
      image = imageDetailsSchema.parse(
        JSON.parse(
          await toolEngine(["inspect", "--type", "image", definition.image!], options.signal),
        )[0],
      );
    } catch {
      stage(`Pulling development image: ${definition.image!}`);
      await toolEngine(["pull", definition.image!], options.signal);
      image = imageDetailsSchema.parse(
        JSON.parse(
          await toolEngine(["inspect", "--type", "image", definition.image!], options.signal),
        )[0],
      );
    }
    validateHostEnvironmentImports(
      image.Config.Labels?.["devcontainer.metadata"] ?? "",
      options.hostEnvironment,
    );
    validateImageIsolation(image, approvedMountArguments);
    if (options.resolved.layers && !options.checkpointImage) {
      if (!options.cacheDirectory) {
        throw new Error("Layered provisioning requires a private image cache directory");
      }
      stage("Resolving shared tooling artifacts and infrastructure image…");
      const platform = await inspectToolPlatform({
        run: toolEngine,
        imageId: image.Id,
        signal: options.signal,
        approvedMountArguments,
      });
      const ports = createToolBuildPorts({
        directory: options.cacheDirectory,
        run: toolEngine,
        approvedMountArguments,
      });
      const builderImageId = await ports.resolveBuilder(platform, options.signal);
      stage("Verifying read-only tool image mount capability…");
      await requireToolImageMountCapability({
        directory: options.cacheDirectory,
        builderImageId,
        ports,
        run: toolEngine,
        signal: options.signal,
        report: (text) => options.progress?.(`${text}\n`),
      });
      stage("Resolving cached language servers, runtimes, and infrastructure…");
      const provisioned = await provisionEnvironmentImage({
        builderImageId,
        baseImageId: image.Id,
        imageUser: image.Config.User || "root",
        platform,
        layers: options.resolved.layers,
        cacheDirectory: options.cacheDirectory,
        ports,
        savedTools:
          toolImageMounts !== undefined && toolInventory
            ? { inventory: toolInventory, mounts: toolImageMounts }
            : undefined,
        signal: options.signal,
        report: (text) => options.progress?.(`${text}\n`),
      });
      image = imageDetailsSchema.parse(
        JSON.parse(
          await toolEngine(["inspect", "--type", "image", provisioned.imageId], options.signal),
        )[0],
      );
      toolInventory = provisioned.inventory;
      toolImageMounts = provisioned.toolImageMounts;
      validateImageIsolation(image, approvedMountArguments);
    }
    if (options.resolved.layers && options.checkpointImage && toolImageMounts === undefined) {
      throw new Error(
        "Approve a session rebuild to replace legacy copied tools with image mounts. The checkpoint remains unchanged.",
      );
    }
    if (toolImageMounts !== undefined) {
      toolImageMounts = toolImageMountsSchema.parse(toolImageMounts);
      if (!toolInventory) {
        throw new Error("Mounted tools require their saved tool inventory");
      }
      validateToolImageInventory(toolImageMounts, toolInventory);
      for (const mount of toolImageMounts) {
        await verifySavedToolArtifact(mount, toolEngine, options.signal);
      }
      stage("Validating tool artifact mounts and destinations…");
      await verifyToolMountDestinations({
        run: toolEngine,
        imageId: image.Id,
        mounts: toolImageMounts,
        containerName: `pi-tool-destinations-${randomUUID()}`,
        signal: options.signal,
      });
      authority.toolImageMounts = toolImageMounts;
    }
    authority.images.push(image.Id);
    definition.image = image.Id;
    authority.users = [...new Set([...authority.users, image.Config.User || "root"])];
    await writeFile(snapshot, JSON.stringify(definition), { mode: 0o600 });
    if (options.volumes.length) {
      stage("Preparing shared project volumes…");
    }
    for (const volume of options.volumes) {
      await ensureProjectVolume({
        run: toolEngine,
        volume,
        projectRoot: options.resolved.project.root,
        signal: options.signal,
      });
    }
    stage("Starting devcontainer and running lifecycle hooks…");
    const result = JSON.parse(
      await run([
        "up",
        ...common,
        "--buildkit",
        "never",
        "--no-lockfile",
        "--update-remote-user-uid-default",
        "never",
        "--include-merged-configuration",
      ]),
    );
    if (result.outcome !== "success" || typeof result.containerId !== "string") {
      throw new Error("Devcontainer did not become ready");
    }
    createdContainer = result.containerId;
    validateCreatedContainer(
      JSON.parse(await toolEngine(["inspect", result.containerId], options.signal))[0],
      options.sessionId,
      options.mounts,
      toolImageMounts,
      options.volumes,
    );
    stage("Loading container environment…");
    const remoteEnvironmentOutput = await run([
      "exec",
      "--workspace-folder",
      options.resolved.startupDirectory,
      "--config",
      options.resolved.path,
      "--override-config",
      snapshot,
      "--container-id",
      result.containerId,
      "--docker-path",
      adapterPath,
      "--",
      "python3",
      "-c",
      "import json\nimport os\n\nenvironment = dict(os.environ)\nprint(json.dumps(environment))",
    ]);
    const remoteEnvironment = JSON.parse(remoteEnvironmentOutput) as Record<string, string>;
    if (toolInventory) {
      stage("Verifying provisioned runtime executables…");
      await verifyRuntimeInventory({
        run: toolEngine,
        container: result.containerId,
        user: result.remoteUser || image.Config.User || "root",
        inventory: toolInventory,
        toolImageMounts,
        remoteEnvironment,
        workspace: result.remoteWorkspaceFolder || definition.workspaceFolder!,
        signal: options.signal,
      });
    }
    return {
      container: result.containerId,
      image: image.Id,
      user: result.remoteUser || image.Config.User || "root",
      workspace: result.remoteWorkspaceFolder || definition.workspaceFolder!,
      configuration: result.mergedConfiguration ?? {},
      remoteEnvironment,
      ...(toolInventory ? { toolInventory } : {}),
      ...(toolImageMounts !== undefined ? { toolImageMounts } : {}),
    };
  } catch (error) {
    if (createdContainer && createdContainer !== options.previousContainer) {
      await toolEngine(["stop", createdContainer]).catch(() => {});
    }
    throw error;
  } finally {
    await adapter.close();
    await rm(socketDirectory, { recursive: true, force: true });
  }
}
