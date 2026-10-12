import { randomUUID } from "node:crypto";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
import { loadSandboxSettings, sandboxDisclosureRevision } from "./sandbox/settings.ts";
import { checkPolicy } from "./policy.ts";
import { registerSandboxTools } from "./sandbox/tools.ts";
import { registerSandboxToolRequests } from "./sandbox/tool-installation.ts";
import { reviewSandboxAction, reviewSandboxToolCall } from "./sandbox/gate.ts";
import { createSandboxService, SANDBOX_SERVICE_CHANNEL } from "./sandbox/service.ts";
import { createSandboxPublisher } from "./sandbox/events.ts";
import { handleSandboxSetup } from "./sandbox/setup-command.ts";
import { devcontainerPorts } from "./sandbox/ports.ts";
import { SandboxStartupUI } from "./sandbox/startup-ui.ts";
import { defaultToolProfile, globalToolProfilePath } from "./sandbox/tool-profile.ts";
import { publishPrivateText, readPrivateText } from "./sandbox/storage.ts";
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
  const startup = new SandboxStartupUI(() => context);
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
      context?.ui.notify(`Sandbox retirement failed: ${cleanupErrors.map(String).join("; ")}`, "error");
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
      pendingStartup = startup.run("Starting devcontainer", async (progress) => {
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
              const selection = ctx.ui.select(
                "Select devcontainer definition",
                [...paths],
                { signal: startupController.signal },
              );
              return awaitSandboxWork(selection, startupController.signal);
            }),
        });
        startupController.signal.throwIfAborted();
        const toolsPath = globalToolProfilePath(getAgentDir());
        if (!(await readPrivateText(toolsPath))) {
          const profile = defaultToolProfile();
          const preview = [
            "Provision the shared development toolset?",
            toolsPath,
            "All five language servers and isolated supporting runtimes will be available in every supported sandbox. Image builds are cached; project definitions and host access are unchanged.",
            JSON.stringify(profile, null, 2),
          ].join("\n\n");
          if (!(await confirm(preview, "", startupController.signal))) {
            throw new Error("Global tooling provisioning was not approved");
          }
          await publishPrivateText(toolsPath, `${JSON.stringify(profile, null, 2)}\n`, undefined, startupController.signal);
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
                toolingSources: candidate.options.resolved.layers?.sources.map(
                  (source) => source.path,
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
        const disclosureRevision = () => sandboxDisclosureRevision(getAgentDir(), getSession().revision);
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
            if (checkPolicy(settings.settings.permission, policyToolName, policyToolName).state === "deny") {
              throw new Error(`Delegated tool denied by explicit policy: ${policyToolName}`);
            }
          }
          for (const guestPath of guestPaths) {
            await reviewSandboxAction({
              session: candidate,
              canonicalGuestPath: guestPath,
              agentDir: getAgentDir(),
              toolName: "read",
              input: { path: guestPath },
              toolCallId: request.toolCallId,
              ctx: { ...ctx, signal: request.signal },
              confirm: (_safety, category, reason) =>
                request.localSearch
                  ? Promise.resolve(false)
                  : confirm(`${category}: ${reason}`, request.toolCallId, request.signal),
            });
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
              const sourcePaths = [
                ...new Set((request.effects ?? []).map((effect) => effect.path)),
              ];
              const canonicalGuestPaths = sourcePaths.length
                ? await service.authorizeHostSources(sourcePaths, request.signal)
                : [];
              await reviewSourcePaths(request, canonicalGuestPaths);
              if (typeof requestedHostPath === "string" && !request.effects?.length) {
                await service.authorizeHostSource(requestedHostPath, request.signal);
              }
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
          toolingSources: resolved.layers?.sources.map((source) => source.path),
          toolingRevision: candidate.environment.toolInventory?.revision,
          containerId: candidate.environment.container,
          containerName: candidate.containerName,
          image: candidate.environment.image,
          cwd: candidate.environment.workspace,
          mounts: [...candidate.mounts],
          ports: devcontainerPorts(resolved.definition.forwardPorts ?? []),
        });
        ctx.ui.setStatus("sandbox", "🔒 devcontainer");
      }, startupController.signal);
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
    const hostCommandGuidance = `Project host-command rules at ${hostCommands.path}: ${JSON.stringify(hostCommands.rules)}. Matching literal executable invocations run natively on the host with any arguments and the host environment; guest Bash retains sequencing, pipes, redirects, and argument expansion. Host cwd must map inside this project. Only explicit command-prefix environment assignments are forwarded, excluding shell/runtime lookup variables. Host scripts and their children are trusted native execution, not container-isolated. Dynamic executable names, functions, and opaque shell wrappers are unsupported when host rules are configured; use direct commands and project-relative arguments.`;
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
        toolCallId: event.toolCallId,
        ctx,
        confirm: (_safety, category, reason) =>
          confirm(`${category}: ${reason}\n${JSON.stringify(event.input)}`, event.toolCallId),
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
      if (args.trim() === "host-commands") {
        const profile = await loadHostCommandProfile(
          getAgentDir(),
          getSession().options.resolved.project,
        );
        ctx.ui.notify(
          `${profile.path}\n${JSON.stringify({ hostCommands: profile.rules }, null, 2)}\nEdit this private file manually to authorize native project commands. No approval or image rebuild is needed.`,
          "info",
        );
        return;
      }
      if (args.trim().startsWith("setup")) {
        const currentSetupSandbox = session ? createSandboxService(session) : undefined;
        await handleSandboxSetup(args.trim().slice(5).trim(), ctx, currentSetupSandbox);
        await start(ctx);
        return;
      }
      if (args.trim() === "build" || args.trim() === "rebuild") {
        await ctx.waitForIdle();
        await getSession().rebuild(ctx.signal);
        return;
      }
      ctx.ui.notify(
        session
          ? `${session.environment.container}\nBase: ${session.options.resolved.path}\nTooling sources: ${session.options.resolved.layers?.sources.map((source) => source.path).join(", ") ?? "legacy definition"}\nTool inventory: ${session.environment.toolInventory?.revision ?? "unavailable"}\n${session.environment.workspace}\n${JSON.stringify(session.mounts)}`
          : unavailable,
        "info",
      );
    },
  });
}
