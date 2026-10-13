import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { evaluateSafety, type GuardPathFact, type SafetyContext } from "./auto/safety-policy.ts";
import { guestToHost } from "./sandbox/mounts.ts";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { editConfigDraft } from "@paulsteele/pi-shared-ui";
import { ApprovalQueue } from "./approval-queue.ts";
import { awaitSandboxWork } from "./sandbox/cancellation.ts";
import { createDelegatedReviewService, REVIEW_SERVICE_CHANNEL } from "./delegated-review.ts";
import { buildPermissionPromptPayload } from "./prompt/payload.ts";
import {
  appendPermissionRequest,
  appendPermissionOutcome,
  registerPermissionEntryRenderers,
} from "./prompt/entries.ts";
import { presentPermissionPrompt } from "./prompt/component.ts";
import { emitUiPrompt, emitDecision } from "./permission-events.ts";
import { SandboxSession } from "./sandbox/session.ts";
import { selectDefinition, resolveDefinition } from "./sandbox/definition.ts";
import { configuredEnvironmentSourcePaths } from "./sandbox/environment-layers.ts";
import {
  loadSandboxSettings,
  sandboxDisclosureRevision,
  sandboxStorageRoot,
} from "./sandbox/settings.ts";
import { checkPolicy } from "./policy.ts";
import { registerSandboxTools } from "./sandbox/tools.ts";
import { registerSandboxToolRequests } from "./sandbox/tool-installation.ts";
import { reviewSandboxAction, reviewSandboxToolCall } from "./sandbox/gate.ts";
import { createSandboxService, SANDBOX_SERVICE_CHANNEL } from "./sandbox/service.ts";
import { createSandboxPublisher } from "./sandbox/events.ts";
import { handleSandboxSetup } from "./sandbox/setup-command.ts";
import { devcontainerPorts } from "./sandbox/ports.ts";
import { SandboxStartupUI } from "./sandbox/startup-ui.ts";
import {
  defaultToolProfile,
  globalToolProfilePath,
  parseToolProfile,
  resolveToolProfiles,
} from "./sandbox/tool-profile.ts";
import { publishPrivateText, readPrivateText, sha256Hex } from "./sandbox/storage.ts";
import { loadHostCommandProfile } from "./sandbox/host-command-profile.ts";
import { registerSandboxSettings } from "./sandbox/settings-menu.ts";
import { ReviewerSandboxes } from "./sandbox/reviewer-sandboxes.ts";
import type { ToolReviewRequest } from "./tool-review.ts";

export default function sandboxExtension(pi: ExtensionAPI): void {
  let session: SandboxSession | undefined;
  let pendingCandidate: SandboxSession | undefined;
  let startupAbort: AbortController | undefined;
  let pendingStartup: Promise<void> | undefined;
  let context: ExtensionContext | undefined;
  const startup = new SandboxStartupUI(
    () => context,
    () => {
      const sessionDirectory = context
        ? sha256Hex(context.sessionManager.getSessionId())
        : "pending";
      return join(sandboxStorageRoot(getAgentDir()), "sessions", sessionDirectory, "startup-logs");
    },
  );
  let unavailable = "Sandbox has not initialized";
  let generation = 0;
  let approvals = new ApprovalQueue();
  const publisher = createSandboxPublisher(pi.events);
  let delegated: ReturnType<typeof createDelegatedReviewService> | undefined;
  let reviewerSandboxes: ReviewerSandboxes | undefined;
  let retireService: (() => void) | undefined;
  const getSession = () => {
    if (!session) {
      throw new Error(unavailable);
    }
    if (!session.environment.container) {
      throw new Error("Sandbox container is not ready");
    }
    return session;
  };
  registerPermissionEntryRenderers(pi);
  registerSandboxTools(pi, getSession);
  registerSandboxToolRequests(pi, getSession);
  const agentDir = getAgentDir();
  registerSandboxSettings(pi, agentDir, getSession);

  async function confirm(
    preview: string,
    toolCallId = "",
    operationSignal?: AbortSignal,
  ): Promise<boolean> {
    const ctx = context;
    if (!ctx?.hasUI) {
      return false;
    }
    const owner = generation;
    const requestId = `sandbox-${randomUUID()}`;
    const payload = buildPermissionPromptPayload({
      surface: "sandbox",
      value: preview,
      matchedPattern: null,
      review: { source: "policy", reason: "Operator authorization expands sandbox authority" },
      toolName: "sandbox",
      command: null,
      cwd: ctx.cwd,
    });
    const promptSignal = operationSignal ?? ctx.signal;
    return approvals.run(promptSignal, async (signal) => {
      if (owner !== generation) {
        return false;
      }
      emitUiPrompt(pi.events, {
        requestId,
        toolCallId: toolCallId || null,
        source: "tool_call",
        surface: "sandbox",
        value: preview,
      });
      if (ctx.mode === "tui") {
        appendPermissionRequest(pi, requestId, toolCallId || null, payload);
      }
      const choice = await startup.withoutScreen(() =>
        presentPermissionPrompt(ctx, "Sandbox authorization", payload, false, false, signal),
      );
      const allowed = owner === generation && !signal.aborted && choice === "approve";
      if (ctx.mode === "tui") {
        appendPermissionOutcome(pi, requestId, toolCallId || null, allowed ? "approve" : "deny");
      }
      emitDecision(pi.events, {
        requestId,
        toolCallId: toolCallId || null,
        surface: "sandbox",
        value: preview,
        result: allowed ? "allow" : "deny",
        resolution: allowed ? "user_approved" : "user_denied",
        decidedBy: { kind: "human" },
      });
      return allowed;
    });
  }

  async function retire(): Promise<void> {
    startup.dispose();
    generation++;
    approvals.dispose();
    startupAbort?.abort();
    await pendingStartup?.catch(() => {});
    const previous = session ?? pendingCandidate;
    session = undefined;
    pendingCandidate = undefined;
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      () => delegated?.dispose(),
      () => reviewerSandboxes?.dispose(),
      () => previous?.close(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    reviewerSandboxes = undefined;
    retireService?.();
    retireService = undefined;
    if (cleanupErrors.length) {
      context?.ui.notify(
        `Sandbox retirement failed: ${cleanupErrors.map(String).join("; ")}`,
        "error",
      );
    }
  }

  async function start(ctx: ExtensionContext): Promise<void> {
    await retire();
    context = ctx;
    approvals = new ApprovalQueue();
    unavailable = "Mandatory sandbox is initializing";
    const owner = generation;
    const startupController = new AbortController();
    startupAbort = startupController;
    try {
      pendingStartup = startup.run(
        "Starting devcontainer",
        async (progress) => {
          startupController.signal.throwIfAborted();
          progress.stage("Loading sandbox settings…");
          const settings = await loadSandboxSettings(getAgentDir());
          if (settings.needsMigration) {
            throw new Error("Run /sandbox setup to migrate legacy auto-mode settings");
          }
          const selected = await selectDefinition({
            agentDir: getAgentDir(),
            cwd: ctx.cwd,
            choose: async (paths) =>
              startup.withoutScreen(async () => {
                if (!ctx.hasUI) {
                  return undefined;
                }
                const selection = ctx.ui.select("Select devcontainer definition", [...paths], {
                  signal: startupController.signal,
                });
                return awaitSandboxWork(selection, startupController.signal);
              }),
          });
          startupController.signal.throwIfAborted();
          const toolsPath = globalToolProfilePath(getAgentDir());
          if (!(await readPrivateText(toolsPath))) {
            let profile = defaultToolProfile();
            if (ctx.mode === "tui") {
              const edited = await startup.withoutScreen(() =>
                editConfigDraft(
                  ctx,
                  "Shared development toolset",
                  JSON.stringify(profile, null, 2),
                  startupController.signal,
                ),
              );
              if (edited === undefined) {
                throw new Error("Global tooling configuration cancelled");
              }
              profile = parseToolProfile(JSON.parse(edited));
              resolveToolProfiles(profile);
            }
            const preview = [
              "Provision the shared development toolset?",
              toolsPath,
              "Save the shared tool configuration from your editor. These tools and their supporting runtimes will be available in every supported sandbox. Image builds are cached; project definitions and host access are unchanged.",
              ...(ctx.mode === "tui" ? [] : [JSON.stringify(profile, null, 2)]),
            ].join("\n\n");
            if (!(await confirm(preview, "", startupController.signal))) {
              throw new Error("Global tooling provisioning was not approved");
            }
            await publishPrivateText(
              toolsPath,
              `${JSON.stringify(profile, null, 2)}\n`,
              undefined,
              startupController.signal,
            );
          }
          progress.stage(`Resolving devcontainer definition: ${selected.path}`);
          const resolved = await resolveDefinition({
            selected,
            agentDir: getAgentDir(),
            hostEnvironment: settings.settings.sandbox.hostEnvironment,
            signal: startupController.signal,
            confirmBuildInput: (preview) => confirm(preview, "", startupController.signal),
          });
          publisher.update({
            sessionId: ctx.sessionManager.getSessionId(),
            phase: "starting",
            definitionPath: resolved.path,
            mounts: [],
            ports: [],
          });
          const candidate = new SandboxSession({
            agentDir: getAgentDir(),
            sessionId: ctx.sessionManager.getSessionId(),
            resolved,
            hostEnvironment: settings.settings.sandbox.hostEnvironment,
            confirm: (preview, operationSignal, toolCallId) =>
              confirm(preview, toolCallId, operationSignal),
            startupTimeoutMs: settings.settings.sandbox.startupTimeoutMs,
            buildTimeoutMs: settings.settings.sandbox.buildTimeoutMs,
            startup,
            signal: startupController.signal,
            changed: () => {
              if (session !== candidate) {
                return;
              }
              try {
                publisher.update({
                  sessionId: ctx.sessionManager.getSessionId(),
                  phase: "ready",
                  definitionPath: candidate.options.resolved.path,
                  toolingSources: configuredEnvironmentSourcePaths(
                    candidate.options.resolved.layers,
                  ),
                  toolingRevision: candidate.environment.toolInventory?.revision,
                  containerId: candidate.environment.container,
                  containerName: candidate.containerName,
                  image: candidate.environment.image,
                  cwd: candidate.environment.workspace,
                  mounts: [...candidate.mounts],
                  ports:
                    candidate.options.resolved.definition.forwardPorts?.filter(
                      (port): port is number => typeof port === "number",
                    ) ?? [],
                });
              } catch {
                publisher.update({
                  sessionId: ctx.sessionManager.getSessionId(),
                  phase: "changing",
                  definitionPath: resolved.path,
                  mounts: [...candidate.mounts],
                  ports: [],
                });
              }
            },
          });
          pendingCandidate = candidate;
          try {
            await candidate.start();
          } catch (error) {
            await candidate.close();
            throw error;
          }
          if (owner !== generation) {
            await candidate.close();
            return;
          }
          session = candidate;
          pendingCandidate = undefined;
          const service = createSandboxService(candidate);
          retireService = pi.events.on(SANDBOX_SERVICE_CHANNEL, (raw) => {
            const request = raw as { version?: unknown; accept?: unknown };
            if (request?.version === 1 && typeof request.accept === "function") {
              request.accept(service);
            }
          });
          const disclosureRevision = () =>
            sandboxDisclosureRevision(getAgentDir(), getSession().revision);
          const reviewSourcePaths = async (request: ToolReviewRequest, guestPaths: string[]) => {
            const settings = await loadSandboxSettings(getAgentDir());
            if (settings.needsMigration) {
              throw new Error("Migrate sandbox settings before delegated source access");
            }
            const policyToolNames = [request.toolName];
            if (request.localSearch) {
              policyToolNames.push("search_source");
            }
            for (const policyToolName of policyToolNames) {
              if (
                checkPolicy(settings.settings.permission, policyToolName, policyToolName).state ===
                "deny"
              ) {
                throw new Error(`Delegated tool denied by explicit policy: ${policyToolName}`);
              }
            }
            const authorizedRevision = disclosureRevision();
            for (const guestPath of guestPaths) {
              await reviewSandboxAction({
                session: candidate,
                canonicalGuestPath: guestPath,
                agentDir: getAgentDir(),
                toolName: "read",
                input: { path: guestPath },
                ctx: { ...ctx, signal: request.signal },
              });
            }
            const requestedPath =
              request.input && typeof request.input === "object"
                ? (request.input as Record<string, unknown>).path
                : undefined;
            const sourceAliases = [
              ...guestPaths,
              ...guestPaths.map((path) => guestToHost(path, candidate.mounts)),
              ...(request.effects ?? []).map((effect) => effect.path),
              ...(typeof requestedPath === "string" ? [requestedPath] : []),
            ].filter((path): path is string => typeof path === "string");
            const paths: GuardPathFact[] = sourceAliases.map((path) => ({
              value: path,
              matchValues: [],
              boundaryValue: path,
              mountAliases: [],
              mountResolutionIncomplete: false,
            }));
            const safetyContext: SafetyContext = {
              requestId: "delegated-disclosure",
              toolCallId: request.toolCallId ?? "",
              toolName: "read",
              agentName: null,
              input: request.input,
              cwd: ctx.cwd,
              platform: process.platform,
              shell: null,
              paths,
              riskMarkers: [],
            };
            const hostSafety = evaluateSafety(safetyContext, false, {
              home: homedir(),
              xdgDataHome: process.env.XDG_DATA_HOME,
              credentialsDirectory: process.env.CREDENTIALS_DIRECTORY,
            });
            const guestSafety = evaluateSafety({ ...safetyContext, platform: "linux" }, false, {
              home: candidate.environment.remoteEnvironment?.HOME ?? "/root",
            });
            const sensitiveSafety = hostSafety.kind === "require_human" ? hostSafety : guestSafety;
            if (sensitiveSafety.kind === "require_human") {
              if (
                request.localSearch ||
                !(await confirm(
                  `Sensitive source disclosure: ${sensitiveSafety.reason}`,
                  request.toolCallId,
                  request.signal,
                ))
              ) {
                throw new Error(
                  "Sensitive source disclosure was not approved; sensitive local scans are refused",
                );
              }
            }
            request.signal?.throwIfAborted();
            if (authorizedRevision !== disclosureRevision()) {
              throw new Error(
                "Disclosure authority changed during sensitive-source authorization; retry",
              );
            }
          };
          const reportReviewerCleanupError = (error: unknown) => {
            ctx.ui.notify(`Reviewer sandbox cleanup failed: ${String(error)}`, "error");
          };
          const sessionReviewerSandboxes = new ReviewerSandboxes(
            candidate,
            reviewSourcePaths,
            reportReviewerCleanupError,
            undefined,
            disclosureRevision,
          );
          reviewerSandboxes = sessionReviewerSandboxes;
          delegated = createDelegatedReviewService({
            sessionId: () => context!.sessionManager.getSessionId(),
            revision: disclosureRevision,
            authority: () => [],
            maxSourcesPerBatch: 32,
            openTask: (spec, operation) => {
              const isWorkerTask = spec.kind === "worker";
              if (!isWorkerTask) {
                return undefined;
              }
              return sessionReviewerSandboxes.openTask(spec, operation);
            },
            cleanupError: reportReviewerCleanupError,
            authorize: async (request) => {
              try {
                const revisionAtAuthorizationStart = disclosureRevision();
                const requestedHostPath =
                  request.input && typeof request.input === "object"
                    ? (request.input as Record<string, unknown>).path
                    : undefined;
                const hasNoEffects = !request.effects?.length;
                const fallbackHostPaths =
                  typeof requestedHostPath === "string" && hasNoEffects ? [requestedHostPath] : [];
                const sourcePaths = [
                  ...new Set([
                    ...(request.effects ?? []).map((effect) => effect.path),
                    ...fallbackHostPaths,
                  ]),
                ];
                const canonicalGuestPaths = sourcePaths.length
                  ? await service.authorizeHostSources(sourcePaths, request.signal)
                  : [];
                await reviewSourcePaths(request, canonicalGuestPaths);
                return { kind: "allowed", revision: revisionAtAuthorizationStart };
              } catch (error) {
                return { kind: "denied", reason: String(error) };
              }
            },
          });
          const delegatedService = delegated;
          const unsubscribe = pi.events.on(REVIEW_SERVICE_CHANNEL, (raw) => {
            const request = raw as { version?: unknown; accept?: unknown };
            if (request?.version === 1 && typeof request.accept === "function") {
              request.accept(delegatedService.service);
            }
          });
          const priorRetirement = retireService;
          retireService = () => {
            priorRetirement?.();
            unsubscribe();
          };
          publisher.update({
            sessionId: ctx.sessionManager.getSessionId(),
            phase: "ready",
            definitionPath: resolved.path,
            toolingSources: configuredEnvironmentSourcePaths(candidate.options.resolved.layers),
            toolingRevision: candidate.environment.toolInventory?.revision,
            containerId: candidate.environment.container,
            containerName: candidate.containerName,
            image: candidate.environment.image,
            cwd: candidate.environment.workspace,
            mounts: [...candidate.mounts],
            ports: devcontainerPorts(resolved.definition.forwardPorts ?? []),
          });
          ctx.ui.setStatus("sandbox", undefined);
        },
        startupController.signal,
      );
      await pendingStartup;
    } catch (error) {
      if (owner !== generation || startupController.signal.aborted) {
        return;
      }
      unavailable = String(error);
      ctx.ui.notify(unavailable, "error");
      publisher.update({
        sessionId: ctx.sessionManager.getSessionId(),
        phase: "unavailable",
        definitionPath: "",
        mounts: [],
        ports: [],
        error: unavailable,
      });
    } finally {
      if (startupAbort === startupController) {
        pendingStartup = undefined;
        startupAbort = undefined;
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await start(ctx);
  });
  pi.on("session_shutdown", async () => {
    await retire();
    publisher.dispose();
  });
  pi.on("session_tree", async (_event, ctx) => {
    generation++;
    startupAbort?.abort();
    await pendingStartup?.catch(() => {});
    await delegated?.retireOperations();
    approvals.dispose();
    approvals = new ApprovalQueue();
    context = ctx;
  });
  pi.on("before_agent_start", async (event) => {
    const current = getSession();
    const hostCommands = await loadHostCommandProfile(
      getAgentDir(),
      current.options.resolved.project,
    );
    event.systemPromptOptions.cwd = current.environment.workspace;
    const hostCommandGuidance = `Project host-command rules at ${hostCommands.path}: ${JSON.stringify(hostCommands.rules)}. Matching literal executable invocations run natively on the host with any arguments and the host environment; guest Bash retains sequencing, pipes, redirects, and argument expansion. Host cwd must map inside this project. Only explicit command-prefix environment assignments are forwarded, excluding shell/runtime lookup variables. Host scripts and their children are trusted native execution, not container-isolated. Only statically matched command names route to the host; dynamic executable names, function definitions and their calls, and commands inside opaque shell strings run in the container. Use direct commands and project-relative arguments when native routing is needed.`;
    const trustedToolGuidance = `Trusted host tools do not receive additional sandbox prompts: pi-web-access provides web_search, source_check, fetch_content, and get_search_content; @plannotator/pi-extension provides plannotator, plannotator_submit_plan, and plannotator_mark_done; @juicesharp/rpiv-ask-user-question provides ask_user_question. Their internal file, subprocess, credential, and network operations are not container-isolated.`;
    const mountGuidance = `Writable binds expose real host data; secret protection is best-effort and Internet access permits uploads. Guest cwd: ${current.environment.workspace}. Approved mounts: ${JSON.stringify(current.mounts.map(({ source, destination, access }) => ({ source, destination, access })))}. Use request_host_mount to request more host access; only the operator can approve it.`;
    const toolInstallationGuidance = `When a required development tool is missing, use request_sandbox_tool to propose a pinned installation into the active definition rather than silently substituting another runtime or using host tools. Installation requires operator approval and rebuilds the container. Layered installs are saved privately for this project; shared tools are configured separately, and repository base definitions are not rewritten.`;
    event.systemPromptOptions.sections.sandbox = [
      "Built-in file tools and the Bash shell run inside a mandatory Linux Podman devcontainer.",
      hostCommandGuidance,
      trustedToolGuidance,
      "Explicit tool denies still apply.",
      mountGuidance,
      toolInstallationGuidance,
      "No automatic host fallback or sandbox-off mode exists.",
    ].join(" ");
  });
  pi.on("tool_call", async (event, ctx) => {
    try {
      const tool = pi.getAllTools().find((tool) => tool.name === event.toolName);
      await reviewSandboxToolCall({
        tool,
        getSession,
        agentDir: getAgentDir(),
        input: event.input,
        ctx,
      });
      return {};
    } catch (error) {
      return { block: true, reason: String(error) };
    }
  });
  pi.registerTool({
    name: "request_host_mount",
    label: "Request host mount",
    exposure: "model-only",
    executionMode: "sequential",
    description:
      "Request a human-approved host file/directory bind for this Pi session, including resume. Container processes restart when approved. Cannot disable sandboxing.",
    parameters: Type.Object({
      path: Type.String(),
      destination: Type.Optional(Type.String()),
      access: Type.Union([Type.Literal("ro"), Type.Literal("rw")]),
      reason: Type.String({ minLength: 1, maxLength: 2000 }),
    }),
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const mount = await getSession().requestMount(
        input.path,
        input.access,
        input.destination,
        input.reason,
        signal,
        _id,
      );
      return { content: [{ type: "text", text: JSON.stringify(mount) }], details: mount };
    },
  });
  pi.registerCommand("sandbox", {
    description: "Mandatory devcontainer status and explicit setup",
    async handler(args, ctx) {
      if (args.trim() === "logs") {
        ctx.ui.notify(
          startup.latestLogPath
            ? `Latest sandbox diagnostic log:\n${startup.latestLogPath}\nMay contain secrets from lifecycle output or container environment. Inspect and redact before sharing.`
            : "No sandbox diagnostic log is available for this runtime.",
          "info",
        );
        return;
      }
      if (args.trim().startsWith("setup")) {
        await handleSandboxSetup(args.trim().slice(5).trim(), ctx);
        await start(ctx);
        return;
      }
      if (args.trim() === "build" || args.trim() === "rebuild") {
        await ctx.waitForIdle();
        await getSession().rebuild(ctx.signal);
        return;
      }
      const mountedToolDetails = session?.environment.toolImageMounts;
      const toolingStorageStatus =
        mountedToolDetails === undefined
          ? "Tool storage: legacy image installations"
          : [
              "Tool storage: read-only artifact image mounts",
              ...mountedToolDetails.map(
                (mount) =>
                  `${mount.toolId}@${mount.version}: ${mount.imageId} -> ${mount.destination}`,
              ),
            ].join("\n");
      ctx.ui.notify(
        session
          ? `${session.environment.container}\n${toolingStorageStatus}\nBase: ${session.options.resolved.path}\nTooling sources: ${configuredEnvironmentSourcePaths(session.options.resolved.layers)?.join(", ") ?? "legacy definition"}\nTool inventory: ${session.environment.toolInventory?.revision ?? "unavailable"}\n${session.environment.workspace}\n${JSON.stringify(session.mounts)}\nDiagnostic log: ${startup.latestLogPath ?? "unavailable"}`
          : `${unavailable}\nDiagnostic log: ${startup.latestLogPath ?? "unavailable"}`,
        "info",
      );
    },
  });
}
