import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { resolveGitRepository } from "@paulsteele/pi-project-locations";
import { resolveDefinition, type ResolvedDefinition } from "./definition.ts";
import { createDevcontainer, podmanOutput, type PreparedEnvironment } from "./driver.ts";
import {
  createMountGrant,
  reapproveReplacedMounts,
  validateMountIdentity,
  validateMountTopology,
  type MountGrant,
} from "./mounts.ts";
import {
  ensurePrivateDirectory,
  publishPrivateText,
  readPrivateText,
  sha256Hex,
} from "./storage.ts";
import { sandboxStorageRoot } from "./settings.ts";
import { GuestFilesystem } from "./filesystem.ts";
import {
  runGuestProcess,
  processSupervisor as sharedProcessSupervisor,
  type GuestProcessOptions,
} from "./process.ts";
import { declaredBindMount, declaredWorkspaceMount } from "./declaration-mounts.ts";
import { dirname } from "node:path";
import { containerIdentity } from "./container-identity.ts";
import { startLoopbackForwarders, devcontainerPorts } from "./ports.ts";
import {
  silentStartupProgress,
  type SandboxStartupDisplay,
  type SandboxStartupProgress,
} from "./startup-ui.ts";

import {
  executeProjectShell,
  type ShellExecutionOptions,
  type ShellExecutionResult,
} from "./host-command-runner.ts";
import { sessionRecordSchema, type SandboxSessionRecord } from "./session-record.ts";
import { pruneInactiveSessions, removeSupersededContainer } from "./prune.ts";

export type { SandboxSessionRecord } from "./session-record.ts";

async function restartPreviousContainer(previousContainer: string): Promise<void> {
  try {
    await podmanOutput(["start", previousContainer]);
  } catch {
    return;
  }
}

export class SandboxSession {
  readonly directory: string;
  readonly processSupervisor = sharedProcessSupervisor;
  readonly filesystem: GuestFilesystem;
  private record?: SandboxSessionRecord;
  private recordRevision?: string;
  private lock?: Awaited<ReturnType<typeof open>>;
  private forwarders?: Awaited<ReturnType<typeof startLoopbackForwarders>>;
  private readonly lifetime = new AbortController();
  private executionGeneration = new AbortController();
  private closePromise?: Promise<void>;
  private recordPublished = false;
  private readonly active = new Set<Promise<unknown>>();
  private readonly retirementListeners = new Set<() => Promise<void>>();
  private changing = false;
  private drainingGeneration = false;
  private topologyQueue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly options: {
      agentDir: string;
      sessionId: string;
      resolved: ResolvedDefinition;
      hostEnvironment: string[];
      confirm: (preview: string, signal?: AbortSignal, toolCallId?: string) => Promise<boolean>;
      startupTimeoutMs?: number;
      buildTimeoutMs?: number;
      startup?: SandboxStartupDisplay;
      changed?: () => void;
      signal?: AbortSignal;
    },
  ) {
    this.directory = join(
      sandboxStorageRoot(options.agentDir),
      "sessions",
      sha256Hex(options.sessionId),
    );
    this.filesystem = new GuestFilesystem(
      () => this.environment,
      (processOptions) => this.execute(processOptions),
    );
  }

  beforeContainerRetirement(listener: () => Promise<void>): () => void {
    this.retirementListeners.add(listener);
    return () => this.retirementListeners.delete(listener);
  }

  get environment(): PreparedEnvironment {
    if (!this.record || this.changing || this.drainingGeneration || this.lifetime.signal.aborted) {
      throw new Error("Mandatory sandbox is not ready");
    }
    return this.record.environment;
  }
  get mounts(): readonly MountGrant[] {
    return this.record?.mounts ?? [];
  }
  get containerName(): string {
    return containerIdentity({
      projectRoot: this.options.resolved.project.root,
      startupDirectory: this.options.resolved.startupDirectory,
      sessionId: this.options.sessionId,
      generation: this.generation,
    }).name;
  }
  get generation(): number {
    return this.record?.generation ?? 0;
  }
  get revision(): string {
    return this.recordRevision ?? "unavailable";
  }

  private withStartup<T>(
    title: string,
    operation: (progress: SandboxStartupProgress) => Promise<T>,
  ): Promise<T> {
    return this.options.startup
      ? this.options.startup.run(title, operation, this.executionSignal(this.options.signal))
      : operation(silentStartupProgress);
  }

  start(): Promise<void> {
    return this.withStartup("Starting devcontainer", (progress) => this.startPrepared(progress));
  }

  private async startPrepared(progress: SandboxStartupProgress): Promise<void> {
    progress.stage("Preparing devcontainer session…");
    const defaultStartupTimeoutMs = 120_000;
    const startupTimeoutMs = this.options.startupTimeoutMs ?? defaultStartupTimeoutMs;
    const buildTimeoutMs = this.options.buildTimeoutMs ?? 1_800_000;
    const startupSignal = AbortSignal.any([
      this.lifetime.signal,
      ...(this.options.signal ? [this.options.signal] : []),
      AbortSignal.timeout(startupTimeoutMs + buildTimeoutMs),
    ]);
    await ensurePrivateDirectory(this.directory);
    this.lock = await open(join(this.directory, "owner.lock"), "wx", 0o600).catch(() => {
      throw new Error(
        "This Pi session sandbox already has an owner; inspect stale locks explicitly",
      );
    });
    await this.lock.writeFile(JSON.stringify({ pid: process.pid }));
    progress.stage("Pruning inactive sandbox sessions…");
    await pruneInactiveSessions({
      agentDir: this.options.agentDir,
      report: (text) => progress.output(text),
    });
    const stored = await readPrivateText(join(this.directory, "session.json"));
    let previousRecord: SandboxSessionRecord | undefined;
    if (stored) {
      const record = sessionRecordSchema.parse(JSON.parse(stored.text));
      if (
        record.sessionId !== this.options.sessionId ||
        record.startupDirectory !== this.options.resolved.startupDirectory
      ) {
        throw new Error("Stored sandbox belongs to a different session/workspace/definition");
      }
      if (record.definitionRevision !== this.options.resolved.revision) {
        const previousConfiguration = record.environment.configuration;
        const resolvedDefinition = this.options.resolved.definition;
        const forwardPortsChanged =
          JSON.stringify(previousConfiguration.forwardPorts) !==
          JSON.stringify(resolvedDefinition.forwardPorts);
        const appPortChanged =
          JSON.stringify(previousConfiguration.appPort) !==
          JSON.stringify(resolvedDefinition.appPort);
        if (forwardPortsChanged || appPortChanged) {
          throw new Error("Changed environment topology requires separate validation");
        }
        const priorBaseRevision = record.baseDefinitionRevision ?? record.definitionRevision;
        if (priorBaseRevision !== this.options.resolved.baseRevision) {
          throw new Error(
            "Stored sandbox base definition changed; validate a new session before changing its topology",
          );
        }
        if (
          !(await this.options.confirm(
            "Shared or project tooling changed. Rebuild this session with saved host binds? Container-local changes will be discarded.",
            startupSignal,
          ))
        ) {
          throw new Error("Tooling rebuild was not approved");
        }
      }
      progress.stage("Validating saved host mounts…");
      const mounts = await reapproveReplacedMounts({
        mounts: record.mounts,
        privateStorage: sandboxStorageRoot(this.options.agentDir),
        confirm: this.options.confirm,
        signal: startupSignal,
      });
      previousRecord = record;
      this.record = record;
      this.recordRevision = stored.revision;
      this.recordPublished = true;
      this.record = await this.resumeContainer(record, mounts, startupSignal, progress);
    } else {
      const privateStorage = sandboxStorageRoot(this.options.agentDir);
      await ensurePrivateDirectory(privateStorage);
      const workspace = declaredWorkspaceMount(
        this.options.resolved.definition,
        this.options.resolved.startupDirectory,
      );
      const workspaceGrant = await createMountGrant({
        path: workspace.path,
        destination: workspace.destination,
        access: workspace.access,
        privateStorage,
      });
      if (
        workspaceGrant.source !== this.options.resolved.startupDirectory &&
        !(await this.options.confirm(
          `Workspace declaration expands host access: ${workspaceGrant.source} -> ${workspaceGrant.destination} (${workspaceGrant.access})`,
        ))
      ) {
        throw new Error("Expanded workspace mount was not approved");
      }
      const mountGrants = [workspaceGrant];
      for (const mountDeclaration of this.options.resolved.definition.mounts ?? []) {
        const bindMount = declaredBindMount(mountDeclaration, dirname(this.options.resolved.path));
        const grant = await createMountGrant({ ...bindMount, privateStorage });
        if (
          !(await this.options.confirm(
            `Approve declared host bind for this session? ${grant.source} -> ${grant.destination} (${grant.access})`,
          ))
        ) {
          throw new Error("Declared host mount was not approved");
        }
        mountGrants.push(grant);
      }
      if (this.options.resolved.project.kind === "repos") {
        const repository = await resolveGitRepository(this.options.resolved.startupDirectory);
        const metadataIsInsideWorkspace =
          repository.commonDir === workspaceGrant.source ||
          repository.commonDir.startsWith(`${workspaceGrant.source}/`);
        if (!metadataIsInsideWorkspace) {
          const metadataGrant = await createMountGrant({
            path: repository.commonDir,
            access: "rw",
            privateStorage,
          });
          const approvesSharedGitMetadata = await this.options.confirm(
            `Linked-worktree Git metadata is outside the startup directory. Bind ${metadataGrant.source} at ${metadataGrant.destination} read-write for this session? Git branch/commit operations can affect other worktrees sharing this directory.`,
            startupSignal,
          );
          if (approvesSharedGitMetadata) {
            mountGrants.push(metadataGrant);
          }
        }
      }
      validateMountTopology(mountGrants);
      const environment = await createDevcontainer({
        resolved: this.options.resolved,
        cacheDirectory: join(sandboxStorageRoot(this.options.agentDir), "tool-cache"),
        buildTimeoutMs: this.options.buildTimeoutMs,
        startupTimeoutMs: this.options.startupTimeoutMs,
        mounts: mountGrants,
        privateStorage: sandboxStorageRoot(this.options.agentDir),
        sessionId: this.options.sessionId,
        directory: this.directory,
        hostEnvironment: this.options.hostEnvironment,
        generation: 1,
        signal: startupSignal,
        progress: (text) => progress.output(text),
        confirmHostInitialization: (preview) => this.options.confirm(preview, startupSignal),
      });
      this.record = {
        version: 1,
        sessionId: this.options.sessionId,
        startupDirectory: this.options.resolved.startupDirectory,
        definitionRevision: this.options.resolved.revision,
        baseDefinitionRevision: this.options.resolved.baseRevision,
        generation: 1,
        mounts: mountGrants,
        environment,
      };
    }
    const declaredPorts = devcontainerPorts(this.options.resolved.definition.forwardPorts ?? []);
    const requiresPortApproval = declaredPorts.some((port) => !this.record?.approvedPorts?.includes(port));
    if (requiresPortApproval) {
      const approvedPortForwarding = await this.options.confirm(
        `Expose these devcontainer ports on host loopback only? ${declaredPorts.join(", ")}`,
        startupSignal,
      );
      if (!approvedPortForwarding) {
        throw new Error("Loopback port forwarding was not approved");
      }
    }
    startupSignal.throwIfAborted();
    progress.stage("Starting approved port forwarders…");
    this.record = {
      ...this.record!,
      approvedPorts: declaredPorts,
      inactiveSinceUnixMs: undefined,
      containerPrunedAtUnixMs: undefined,
    };
    try {
      await this.startForwarders();
      await this.persist();
      this.recordPublished = true;
    } catch (error) {
      await this.forwarders?.close();
      if (
        previousRecord &&
        this.record.environment.container !== previousRecord.environment.container
      ) {
        await podmanOutput(["stop", this.record.environment.container]).catch(() => {});
        this.record = previousRecord;
        if (previousRecord.containerPrunedAtUnixMs === undefined) {
          await restartPreviousContainer(previousRecord.environment.container);
        }
      }
      throw error;
    }
    if (previousRecord && previousRecord.containerPrunedAtUnixMs === undefined) {
      await removeSupersededContainer(
        previousRecord.environment.container,
        this.record.environment.container,
        (text) => progress.output(text),
      );
    }
    this.options.changed?.();
  }

  private async resumeContainer(
    record: SandboxSessionRecord,
    mounts: MountGrant[],
    signal: AbortSignal,
    progress: SandboxStartupProgress,
  ): Promise<SandboxSessionRecord> {
    const requiresMountRecreation = mounts.some(
      (mount, index) => mount.identity !== record.mounts[index].identity,
    );
    const containerWasPruned = record.containerPrunedAtUnixMs !== undefined;
    const toolingChanged = record.definitionRevision !== this.options.resolved.revision;
    const requiresNewContainer = requiresMountRecreation || containerWasPruned || toolingChanged;
    const generation = record.generation + (requiresNewContainer ? 1 : 0);
    let checkpointImage =
      containerWasPruned || toolingChanged ? undefined : record.environment.image;
    try {
      if (containerWasPruned) {
        progress.output(
          "Saved sandbox container was pruned after inactivity; recreating from its definition. Container-local changes are no longer available.\n",
        );
      } else if (toolingChanged) {
        progress.stage("Stopping previous container for changed tooling…");
        await podmanOutput(["stop", record.environment.container], signal);
      } else if (requiresMountRecreation) {
        progress.stage("Checkpointing container-local state before rebinding replaced sources…");
        await podmanOutput(["stop", record.environment.container], signal);
        checkpointImage = (
          await podmanOutput(
            ["commit", "--include-volumes=false", record.environment.container],
            signal,
          )
        ).trim();
      }
      signal.throwIfAborted();
      const environment = await createDevcontainer({
        resolved: this.options.resolved,
        cacheDirectory: join(sandboxStorageRoot(this.options.agentDir), "tool-cache"),
        buildTimeoutMs: this.options.buildTimeoutMs,
        startupTimeoutMs: this.options.startupTimeoutMs,
        checkpointInventory: checkpointImage ? record.environment.toolInventory : undefined,
        mounts,
        privateStorage: sandboxStorageRoot(this.options.agentDir),
        sessionId: this.options.sessionId,
        directory: requiresNewContainer
          ? join(this.directory, `generation-${generation}`)
          : this.directory,
        hostEnvironment: this.options.hostEnvironment,
        signal,
        previousContainer: requiresNewContainer ? undefined : record.environment.container,
        checkpointImage,
        generation,
        progress: (text) => progress.output(text),
        confirmHostInitialization: (preview) => this.options.confirm(preview, signal),
      });
      return {
        ...record,
        mounts,
        generation,
        environment,
        definitionRevision: this.options.resolved.revision,
        baseDefinitionRevision: this.options.resolved.baseRevision,
      };
    } catch (error) {
      if ((requiresMountRecreation || toolingChanged) && !containerWasPruned) {
        await restartPreviousContainer(record.environment.container);
      }
      throw error;
    }
  }

  async execute(
    options: Omit<GuestProcessOptions, "container" | "user" | "cwd"> & { cwd?: string },
  ) {
    const environment = this.environment;
    const signal = this.executionSignal(options.signal);
    const operation = runGuestProcess({
      ...options,
      container: environment.container,
      user: environment.user,
      cwd: options.cwd ?? environment.workspace,
      environment: { ...environment.remoteEnvironment, ...options.environment },
      signal,
    });
    this.active.add(operation);
    try {
      return await operation;
    } finally {
      this.active.delete(operation);
    }
  }

  async executeShell(options: ShellExecutionOptions): Promise<ShellExecutionResult> {
    if (!this.environment.container) {
      throw new Error("Shell execution requires a ready sandbox container");
    }
    const signal = this.executionSignal(options.signal);
    const operation = executeProjectShell(this, { ...options, signal });
    this.active.add(operation);
    try {
      return await operation;
    } finally {
      this.active.delete(operation);
    }
  }

  async terminateProcessGroup(processRecordPath: string): Promise<void> {
    if (!/^\/tmp\/pi-sandbox-processes\/lsp-[a-f0-9-]+$/.test(processRecordPath)) {
      throw new Error("Invalid language-server process record");
    }
    const environment = this.record?.environment;
    if (!environment) {
      return;
    }
    const terminateRecordedGroup = `import os
import pathlib
import signal
import sys
record = pathlib.Path(sys.argv[1])
if record.exists():
    try:
        os.killpg(int(record.read_text()), signal.SIGKILL)
    except ProcessLookupError:
        pass`;
    await runGuestProcess({
      container: environment.container, user: environment.user, cwd: environment.workspace,
      command: ["python3", "-c", terminateRecordedGroup, processRecordPath],
      timeoutMs: 5000, signal: AbortSignal.timeout(5000),
    });
  }

  private executionSignal(callerSignal?: AbortSignal): AbortSignal {
    const signals = [this.lifetime.signal, this.executionGeneration.signal];
    if (callerSignal) {
      signals.push(callerSignal);
    }
    return AbortSignal.any(signals);
  }

  requestMount(
    path: string,
    access: "ro" | "rw",
    destination: string | undefined,
    reason: string,
    signal?: AbortSignal,
    toolCallId?: string,
  ): Promise<MountGrant> {
    const operation = this.topologyQueue.then(() =>
      this.withStartup("Updating devcontainer mounts", (progress) =>
        this.changeMount(path, access, destination, reason, progress, signal, toolCallId),
      ),
    );
    this.topologyQueue = operation.catch(() => {});
    return operation;
  }

  private async changeMount(
    path: string,
    access: "ro" | "rw",
    destination: string | undefined,
    reason: string,
    progress: SandboxStartupProgress,
    signal?: AbortSignal,
    toolCallId?: string,
  ): Promise<MountGrant> {
    progress.stage("Validating requested host mount…");
    const operationSignal = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    operationSignal.throwIfAborted();
    const previous = this.record;
    if (!previous) {
      throw new Error("Sandbox is unavailable");
    }
    const grant = await createMountGrant({
      path,
      destination,
      access,
      privateStorage: sandboxStorageRoot(this.options.agentDir),
    });
    const existing = previous.mounts.find(
      (mount) => mount.source === grant.source && mount.destination === grant.destination,
    );
    const existingGrantIsReadWrite = existing?.access === "rw";
    const existingGrantHasRequestedAccess = existing?.access === access;
    if (existing && (existingGrantIsReadWrite || existingGrantHasRequestedAccess)) {
      return existing;
    }
    const updatedMounts = [...previous.mounts.filter((mount) => mount !== existing), grant];
    validateMountTopology(updatedMounts);
    const approvedRevision = this.revision;
    if (
      !(await this.options.confirm(
        `Bind host path for this Pi session?\nSource: ${path}\nCanonical source: ${grant.source}\nDestination: ${grant.destination}\nAccess: ${access}\nReason: ${reason}\nContainer processes and language servers will restart.`,
        operationSignal,
        toolCallId,
      ))
    ) {
      throw new Error("Host mount was not approved");
    }
    operationSignal.throwIfAborted();
    if (approvedRevision !== this.revision) {
      throw new Error("Sandbox mount request became stale");
    }
    await validateMountIdentity(grant);
    await this.retireGeneration();
    this.changing = true;
    this.options.changed?.();
    let replacementContainer: string | undefined;
    try {
      await Promise.allSettled([...this.active]);
      operationSignal.throwIfAborted();
      progress.stage("Checkpointing container-local state…");
      await this.forwarders?.close();
      await podmanOutput(["stop", previous.environment.container]);
      const checkpoint = await podmanOutput([
        "commit",
        "--include-volumes=false",
        previous.environment.container,
      ]);
      const generation = previous.generation + 1;
      const environment = await createDevcontainer({
        resolved: this.options.resolved,
        cacheDirectory: join(sandboxStorageRoot(this.options.agentDir), "tool-cache"),
        buildTimeoutMs: this.options.buildTimeoutMs,
        startupTimeoutMs: this.options.startupTimeoutMs,
        checkpointInventory: previous.environment.toolInventory,
        mounts: updatedMounts,
        privateStorage: sandboxStorageRoot(this.options.agentDir),
        sessionId: this.options.sessionId,
        directory: join(this.directory, `generation-${generation}`),
        hostEnvironment: this.options.hostEnvironment,
        generation,
        checkpointImage: checkpoint.trim(),
        signal: operationSignal,
        progress: (text) => progress.output(text),
        confirmHostInitialization: (preview) =>
          this.options.confirm(preview, operationSignal, toolCallId),
      });
      replacementContainer = environment.container;
      await this.startForwarders(environment);
      this.record = { ...previous, generation, mounts: updatedMounts, environment };
      await this.persist();
    } catch (error) {
      await this.forwarders?.close();
      if (replacementContainer) {
        await podmanOutput(["stop", replacementContainer]).catch(() => {});
      }
      this.record = previous;
      if (!this.lifetime.signal.aborted) {
        await restartPreviousContainer(previous.environment.container);
        await this.startForwarders(previous.environment);
      }
      throw error;
    } finally {
      this.executionGeneration = new AbortController();
      this.drainingGeneration = false;
      this.changing = false;
      this.options.changed?.();
    }
    await removeSupersededContainer(
      previous.environment.container,
      this.record!.environment.container,
      (text) => progress.output(text),
    );
    return grant;
  }

  async rebuild(signal?: AbortSignal): Promise<void> {
    if (
      !(await this.options.confirm(
        "Rebuild this session devcontainer from its approved definition? This discards container-local changes. Host binds are preserved.",
        signal,
      ))
    ) {
      throw new Error("Devcontainer rebuild was not approved");
    }
    const resolved = await resolveDefinition({
      selected: this.options.resolved,
      agentDir: this.options.resolved.layers ? this.options.agentDir : undefined,
      hostEnvironment: this.options.hostEnvironment,
      signal,
      confirmBuildInput: (preview) => this.options.confirm(preview, signal),
    });
    await this.rebuildFromDefinition(resolved, signal);
  }

  rebuildFromDefinition(
    resolved: ResolvedDefinition,
    signal?: AbortSignal,
    publication?: { commit(): Promise<void>; rollback(): Promise<void> },
  ): Promise<void> {
    const operation = this.topologyQueue.then(() =>
      this.withStartup("Rebuilding devcontainer", (progress) =>
        this.replaceDefinition(resolved, progress, signal, publication),
      ),
    );
    this.topologyQueue = operation.catch(() => {});
    return operation;
  }

  private async replaceDefinition(
    resolved: ResolvedDefinition,
    progress: SandboxStartupProgress,
    signal?: AbortSignal,
    publication?: { commit(): Promise<void>; rollback(): Promise<void> },
  ): Promise<void> {
    progress.stage("Validating rebuilt definition and approved mounts…");
    const previous = this.record;
    if (!previous) {
      throw new Error("Cannot rebuild an unavailable sandbox");
    }
    const previousDefinition = this.options.resolved;
    if (
      resolved.startupDirectory !== previousDefinition.startupDirectory ||
      resolved.path !== previousDefinition.path ||
      resolved.project.id !== previousDefinition.project.id
    ) {
      throw new Error(
        "Definition rebuild must retain the session project and active definition path",
      );
    }
    const topologyFields = [
      "workspaceMount",
      "workspaceFolder",
      "mounts",
      "forwardPorts",
      "appPort",
    ] as const;
    for (const field of topologyFields) {
      if (
        JSON.stringify(resolved.definition[field]) !==
        JSON.stringify(previousDefinition.definition[field])
      ) {
        throw new Error(`Definition rebuild cannot change sandbox topology: ${field}`);
      }
    }
    const operationSignal = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    operationSignal.throwIfAborted();
    for (const mount of previous.mounts) {
      await validateMountIdentity(mount);
    }
    progress.stage("Stopping devcontainer language servers…");
    await this.retireGeneration();
    this.changing = true;
    this.options.changed?.();
    let replacementContainer: string | undefined;
    try {
      progress.stage("Waiting for active guest processes…");
      await Promise.allSettled([...this.active]);
      operationSignal.throwIfAborted();
      progress.stage("Stopping the previous devcontainer…");
      await this.forwarders?.close();
      await podmanOutput(["stop", previous.environment.container], operationSignal);
      operationSignal.throwIfAborted();
      const generation = previous.generation + 1;
      const environment = await createDevcontainer({
        resolved,
        cacheDirectory: join(sandboxStorageRoot(this.options.agentDir), "tool-cache"),
        buildTimeoutMs: this.options.buildTimeoutMs,
        startupTimeoutMs: this.options.startupTimeoutMs,
        mounts: previous.mounts,
        privateStorage: sandboxStorageRoot(this.options.agentDir),
        sessionId: this.options.sessionId,
        directory: join(this.directory, `generation-${generation}`),
        hostEnvironment: this.options.hostEnvironment,
        generation,
        signal: operationSignal,
        progress: (text) => progress.output(text),
        confirmHostInitialization: (preview) => this.options.confirm(preview, operationSignal),
      });
      replacementContainer = environment.container;
      operationSignal.throwIfAborted();
      this.options.resolved = resolved;
      progress.stage("Starting rebuilt devcontainer port forwarders…");
      await this.startForwarders(environment);
      this.record = {
        ...previous,
        generation,
        environment,
        definitionRevision: resolved.revision,
        baseDefinitionRevision: resolved.baseRevision,
      };
      progress.stage("Saving rebuilt devcontainer session…");
      operationSignal.throwIfAborted();
      await publication?.commit();
      this.record.definitionRevision = resolved.revision;
      this.record.baseDefinitionRevision = resolved.baseRevision;
      await this.persist(operationSignal);
    } catch (error) {
      this.options.resolved = previousDefinition;
      this.record = previous;
      await this.forwarders?.close();
      if (replacementContainer) {
        await podmanOutput(["stop", replacementContainer]).catch(() => {});
      }
      if (!this.lifetime.signal.aborted) {
        await restartPreviousContainer(previous.environment.container);
        await this.startForwarders(previous.environment);
      }
      await publication?.rollback();
      throw error;
    } finally {
      this.executionGeneration = new AbortController();
      this.drainingGeneration = false;
      this.changing = false;
      this.options.changed?.();
    }
    progress.stage("Removing superseded devcontainer…");
    await removeSupersededContainer(
      previous.environment.container,
      this.record!.environment.container,
      (text) => progress.output(text),
    );
    progress.stage("Devcontainer rebuild complete.");
  }

  private async persist(signal?: AbortSignal): Promise<void> {
    this.recordRevision = await publishPrivateText(
      join(this.directory, "session.json"),
      JSON.stringify(this.record),
      this.recordRevision,
      signal,
    );
  }
  private async startForwarders(environment = this.environment): Promise<void> {
    const ports = this.record?.approvedPorts ?? [];
    this.forwarders = await startLoopbackForwarders({
      container: environment.container,
      user: environment.user,
      ports,
    });
  }
  private async retireGeneration(): Promise<void> {
    this.drainingGeneration = true;
    this.executionGeneration.abort();
    const results = await Promise.allSettled([...this.retirementListeners].map(async (listener) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(listener),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Sandbox service retirement timed out")), 20_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) {
      this.executionGeneration = new AbortController();
      this.drainingGeneration = false;
      throw new AggregateError(failures.map((result) => result.reason), "Sandbox service retirement failed");
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOwnedSession();
    return this.closePromise;
  }

  private async closeOwnedSession(): Promise<void> {
    const cleanupErrors: unknown[] = [];
    const attemptCleanup = async (cleanupOperation: () => Promise<unknown>) => {
      try {
        await cleanupOperation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    this.lifetime.abort();
    await attemptCleanup(() => this.retireGeneration());
    this.retirementListeners.clear();
    this.executionGeneration.abort();
    await attemptCleanup(() => this.topologyQueue);
    await Promise.allSettled([...this.active]);
    await attemptCleanup(async () => this.forwarders?.close());
    if (this.record) {
      await attemptCleanup(() => podmanOutput(["stop", "--time=0", this.record!.environment.container]));
    }
    const lock = this.lock;
    if (lock) {
      try {
        if (this.record && this.recordPublished) {
          this.record = { ...this.record, inactiveSinceUnixMs: Date.now() };
          await attemptCleanup(() => this.persist());
        }
      } finally {
        await attemptCleanup(() => lock.close());
        await attemptCleanup(() => unlink(join(this.directory, "owner.lock")));
        this.lock = undefined;
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, "Sandbox session cleanup failed");
    }
  }
}
