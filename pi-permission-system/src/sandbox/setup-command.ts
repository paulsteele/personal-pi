import { readdir, open, realpath, lstat } from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { globalDefinitionPath, projectDefinitionPath, resolveSandboxProject } from "./definition.ts";
import { loadSandboxSettings, saveSandboxSettings, sandboxDisclosureRevision } from "./settings.ts";
import { proposeDevcontainer, publishApprovedProposal, validateProposal } from "./setup.ts";
import type { SandboxService } from "./service.ts";
import { reviewSandboxAction } from "./gate.ts";
import { readPrivateText } from "./storage.ts";
import { setupEnvironmentLayer } from "./layer-setup.ts";

export async function handleSandboxSetup(
  args: string,
  ctx: ExtensionCommandContext,
  sourceService?: SandboxService,
): Promise<void> {
  if (!ctx.hasUI) {
    throw new Error("Devcontainer setup requires interactive operator approval");
  }
  await ctx.waitForIdle();
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const agentDir = getAgentDir();
  let settings = await loadSandboxSettings(agentDir);
  if (settings.needsMigration) {
    const migrationApproved = await ctx.ui.confirm(
      "Migrate permission settings to mandatory sandboxing?",
      "Retain policy; remove classifier settings and all auto-mode controls.",
    );
    if (!migrationApproved) {
      throw new Error("Sandbox settings migration cancelled");
    }
    await saveSandboxSettings(agentDir, settings.settings, settings.revision, ctx.signal);
    settings = await loadSandboxSettings(agentDir);
  }
  if (args === "model on" || args === "model off") {
    const next = {
      ...settings.settings,
      sandbox: { ...settings.settings.sandbox, modelAssistedSetup: args === "model on" },
    };
    await saveSandboxSettings(agentDir, next, settings.revision, ctx.signal);
    ctx.ui.notify(
      `Explicit setup model assistance ${next.sandbox.modelAssistedSetup ? "enabled" : "disabled"}`,
      "info",
    );
    return;
  }
  if (args === "global tools" || args === "tools" || args === "" || args === "update") {
    const kind =
      args === "global tools"
        ? "global-tools"
        : args === "tools"
          ? "project-tools"
          : "project-environment";
    await setupEnvironmentLayer({ agentDir, ctx, kind });
    return;
  }
  const project = await resolveSandboxProject(ctx.cwd, agentDir);
  const target =
    args === "global" ? globalDefinitionPath(agentDir) : projectDefinitionPath(agentDir, project);
  if (args !== "global" && args !== "base") {
    throw new Error(
      "Use /sandbox setup [global|global tools|tools|base|update|model on|model off]",
    );
  }
  const prior = await readPrivateText(target);
  const mode = await ctx.ui.select(
    `Devcontainer setup\n${target}`,
    settings.settings.sandbox.modelAssistedSetup
      ? ["Propose with current model", "Edit manually"]
      : ["Edit manually"],
  );
  if (!mode) {
    return;
  }
  const manualDraft = prior
    ? {
        definition: JSON.parse(prior.text),
        files: {},
        explanation: "Operator-defined devcontainer",
      }
    : {
        definition: { build: { dockerfile: "Containerfile" } },
        files: {
          Containerfile:
            "FROM docker.io/library/node:24-bookworm\nRUN apt-get update && apt-get install -y --no-install-recommends bash git ripgrep python3 ca-certificates\n",
        },
        explanation: "Base development environment",
      };
  let draft: unknown = manualDraft;
  if (mode === "Propose with current model") {
    if (!sourceService) {
      throw new Error("Model setup source access requires a ready sandbox; use manual setup during bootstrap");
    }
    const disclosureRevision = () => sandboxDisclosureRevision(agentDir, sourceService.revision());
    const evidenceRevision = disclosureRevision();
    const [guestDirectory] = await sourceService.authorizeHostSources([ctx.cwd], ctx.signal);
    const authorizeEvidencePath = async (guestPath: string) => {
      await reviewSandboxAction({
        session: sourceService.session, canonicalGuestPath: guestPath, agentDir,
        toolName: "read", input: { path: guestPath }, toolCallId: "sandbox-setup", ctx,
        confirm: (_context, category, reason) => sourceService.session.options.confirm(`${category}: ${reason}`, ctx.signal),
      });
    };
    await authorizeEvidencePath(guestDirectory!);
    ctx.signal?.throwIfAborted();
    const entries = await readdir(ctx.cwd);
    const manifestIdentities = new Map<string, BigIntStats>();
    const manifestNames = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "global.json"];
    const manifests: Record<string, string> = {};
    const presentManifestNames = manifestNames.filter((name) => entries.includes(name));
    const manifestSources = presentManifestNames.map((name) => ({ name, path: join(ctx.cwd, name) }));
    const manifestPaths = manifestSources.map((source) => source.path);
    for (const { name, path } of manifestSources) {
      const canonical = await realpath(path);
      const manifestFileStat = await lstat(canonical, { bigint: true });
      const guestPaths = await sourceService.authorizeHostSources([canonical], ctx.signal);
      await authorizeEvidencePath(guestPaths[0]!);
      if ((await realpath(path)) !== canonical) {
        throw new Error("Setup manifest changed during authorization");
      }
      ctx.signal?.throwIfAborted();
      const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const openedManifestIdentity = await handle.stat({ bigint: true });
        if (!openedManifestIdentity.isFile() || openedManifestIdentity.dev !== manifestFileStat.dev || openedManifestIdentity.ino !== manifestFileStat.ino) {
          throw new Error("Setup manifest is not a regular file");
        }
        const buffer = Buffer.alloc(8000);
        const manifestRead = await handle.read(buffer, 0, buffer.length, 0);
        manifests[name] = buffer.subarray(0, manifestRead.bytesRead).toString("utf8");
        manifestIdentities.set(name, openedManifestIdentity);
        if ((await realpath(path)) !== canonical) {
          throw new Error("Setup manifest changed during read");
        }
      } finally {
        await handle.close();
      }
    }
    await sourceService.authorizeHostSources(manifestPaths, ctx.signal);
    draft = await proposeDevcontainer({
      ctx,
      evidence: JSON.stringify({
        directory: ctx.cwd,
        files: entries.slice(0, 1000),
        manifests,
        hostPlatform: process.platform,
        containerPlatform: "linux",
        architecture: process.arch,
      }),
      current: prior ? validateProposal(manualDraft).definition : undefined,
      signal: ctx.signal,
      authorizeEvidence: async () => {
        ctx.signal?.throwIfAborted();
        await sourceService.authorizeHostSources([ctx.cwd, ...manifestPaths], ctx.signal);
        for (const { name, path } of manifestSources) {
          const currentIdentity = await lstat(path, { bigint: true });
          const capturedIdentity = manifestIdentities.get(name)!;
          if (!currentIdentity.isFile() || currentIdentity.dev !== capturedIdentity.dev ||
              currentIdentity.ino !== capturedIdentity.ino || currentIdentity.size !== capturedIdentity.size ||
              currentIdentity.mtimeNs !== capturedIdentity.mtimeNs || currentIdentity.ctimeNs !== capturedIdentity.ctimeNs) {
            throw new Error("Setup manifest changed before model disclosure");
          }
        }
        if (disclosureRevision() !== evidenceRevision) {
          throw new Error("Setup source permissions changed before model disclosure");
        }
      },
    });
  }
  const edited = await ctx.ui.editor(
    `Preview devcontainer proposal\n${target}`,
    JSON.stringify(draft, null, 2),
  );
  if (edited === undefined) {
    return;
  }
  await publishApprovedProposal({
    target,
    proposal: validateProposal(JSON.parse(edited)),
    expectedRevision: prior?.revision,
    confirm: (preview) => ctx.ui.confirm("Write this devcontainer definition?", preview),
    signal: ctx.signal,
  });
  ctx.ui.notify(
    `Devcontainer definition written to ${target}. Build, host initialization, and additional mounts still require validation/approval.`,
    "info",
  );
}
