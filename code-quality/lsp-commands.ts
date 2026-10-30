import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	approveLspDraft,
	discardLspDraft,
	loadLspDraft,
	loadLspProfile,
	resolveLspProject,
	saveLspDraft,
	type LspProject,
	type LspRoute,
} from "./lsp-profile.js";
import type { StoredLspProfile } from "./lsp-profile.js";
import { setupLsp, type LspSetupPorts } from "./lsp-setup.js";

export interface LspCommandPorts extends LspSetupPorts {
	setup?(
		mode: "setup" | "edit" | "approve",
		project: LspProject,
		signal: AbortSignal,
	): Promise<StoredLspProfile | undefined>;
	status(project: LspProject): string;
	effectiveRoutes?(): LspRoute[];
	restart(serverId: string | undefined, signal: AbortSignal): Promise<void>;
	reload(signal: AbortSignal): Promise<void>;
	hasPendingCase(): boolean;
	waivePendingLsp(): void;
}

export async function handleLspCommand(
	input: string,
	ctx: ExtensionContext,
	agentDir: string,
	ports: LspCommandPorts,
	signal: AbortSignal,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("LSP quality checking is inactive outside TUI mode", "info");
		return;
	}
	const [action = "status", argument, ...extra] = input.trim().split(/\s+/).filter(Boolean);
	if (extra.length) {
		throw new Error("Too many LSP command arguments");
	}
	const project = await resolveLspProject(ctx.cwd, agentDir);
	if (action === "status") {
		ctx.ui.notify(ports.status(project), "info");
		return;
	}
	if (action === "setup") {
		if (argument && !["edit", "approve", "discard"].includes(argument)) {
			throw new Error("Usage: /quality lsp setup [edit|approve|discard]");
		}
		if (argument === "discard") {
			const pending = await loadLspDraft(agentDir, project);
			if (!pending) {
				ctx.ui.notify("No LSP draft to discard.", "info");
				return;
			}
			const confirmed = await ctx.ui.confirm(
				"Discard LSP configuration draft?",
				"This deletes the shared project's draft, including unapproved edits. The approved profile and pending quality case remain unchanged.",
				{ signal },
			);
			if (!confirmed) {
				return;
			}
			signal.throwIfAborted();
			await discardLspDraft(agentDir, project, pending.revision);
			ctx.ui.notify("LSP draft discarded. The approved profile is unchanged.", "info");
			return;
		}
		const setupMode = argument === "edit" || argument === "approve" ? argument : "setup";
		const approved = ports.setup
			? await ports.setup(setupMode, project, signal)
			: await setupLsp(ctx, agentDir, project, setupMode, ports, signal);
		if (approved) {
			await ports.reload(signal);
			ctx.ui.notify(
				approved.profile.enabled
					? `LSP setup approved.\n${ports.status(project)}`
					: "LSP setup approved; checking is disabled.",
				"info",
			);
		}
		return;
	}
	if (action === "restart") {
		if (
			!(await ctx.ui.confirm(
				"Restart shared language server?",
				"All Pi instances attached to this server will receive fresh diagnostics; pending checks will be invalidated.",
				{ signal },
			))
		)
			return;
		await ports.restart(argument, signal);
		return;
	}
	const active = await loadLspProfile(agentDir, project);
	if (action === "doctor") {
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project before validating its language servers");
		const routes = (ports.effectiveRoutes?.() ?? active?.profile.routes ?? []).filter(
			(route) => !argument || route.id === argument,
		);
		if (!routes.length) {
			if (argument) {
				throw new Error(`Unknown active server: ${argument}`);
			}
			ctx.ui.notify(
				"Automatic LSPs start when supported files are checked; no active routes to validate yet.",
				"info",
			);
			return;
		}
		for (const route of routes) {
			const result = await ports.validate(route, project, signal);
			if (!result.ready) {
				ctx.ui.notify(`${route.id}: ${result.summary}`, "warning");
			}
		}
		return;
	}
	if (action === "on" || action === "off") {
		if (argument) {
			throw new Error("Usage: /quality lsp [on|off]");
		}
		const draft = await loadLspDraft(agentDir, project);
		const hasEditedDraft =
			draft !== undefined && JSON.stringify(draft.draft.profile) !== JSON.stringify(active?.profile);
		if (hasEditedDraft) {
			throw new Error(
				"An edited LSP draft is pending. Run /quality lsp setup approve to validate and activate it, or /quality lsp setup discard to delete it before changing enabled state.",
			);
		}
		const disablesPendingCheck = action === "off" && ports.hasPendingCase();
		const message = disablesPendingCheck
			? "This waives LSP checking for your pending case and disables the shared project profile. Other instances with pending cases must resolve their own waiver."
			: `Turn project LSP checking ${action}? Other instances observe this profile change at their next action boundary.`;
		if (!(await ctx.ui.confirm("Change project LSP checking?", message, { signal }))) {
			return;
		}
		const initialProfile = { version: 1 as const, projectId: project.id, mode: "auto" as const, routes: [] };
		await saveLspDraft(
			agentDir,
			project,
			{
				...(active?.profile ?? initialProfile),
				enabled: action === "on",
			},
			active?.revision ?? null,
			draft?.revision ?? null,
		);
		await approveLspDraft(agentDir, project, (await loadLspDraft(agentDir, project))!.revision);
		if (disablesPendingCheck) {
			ports.waivePendingLsp();
		}
		await ports.reload(signal);
		return;
	}
	throw new Error("Usage: /quality lsp [setup|status|doctor|restart|on|off]");
}
