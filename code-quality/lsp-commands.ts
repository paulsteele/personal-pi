import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	approveLspDraft,
	loadLspDraft,
	loadLspProfile,
	resolveLspProject,
	saveLspDraft,
	type LspProject,
} from "./lsp-profile.js";
import { setupLsp, type LspSetupPorts } from "./lsp-setup.js";

export interface LspCommandPorts extends LspSetupPorts {
	status(project: LspProject): string;
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
	if (extra.length) throw new Error("Too many LSP command arguments");
	const project = await resolveLspProject(ctx.cwd, agentDir);
	if (action === "status") {
		ctx.ui.notify(ports.status(project), "info");
		return;
	}
	if (action === "setup") {
		if (argument && !["edit", "approve"].includes(argument))
			throw new Error("Usage: /quality lsp setup [edit|approve]");
		const setupMode = argument === "edit" || argument === "approve" ? argument : "setup";
		const approved = await setupLsp(ctx, agentDir, project, setupMode, ports, signal);
		if (approved) await ports.reload(signal);
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
	if (!active) throw new Error("No LSP profile; run /quality lsp setup");
	if (action === "doctor") {
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project before validating its language servers");
		const routes = active.profile.routes.filter((route) => !argument || route.id === argument);
		if (!routes.length) throw new Error(`Unknown configured server: ${argument}`);
		for (const route of routes) {
			const result = await ports.validate(route, project, signal);
			ctx.ui.notify(`${route.id}: ${result.summary}`, result.ready ? "info" : "warning");
		}
		return;
	}
	if (action === "on" || action === "off") {
		if (argument) throw new Error("Usage: /quality lsp [on|off]");
		const disablesPendingCheck = action === "off" && ports.hasPendingCase();
		const message = disablesPendingCheck
			? "This waives LSP checking for your pending case and disables the shared project profile. Other instances with pending cases must resolve their own waiver."
			: `Turn project LSP checking ${action}? Other instances observe this profile change at their next action boundary.`;
		if (!(await ctx.ui.confirm("Change project LSP checking?", message, { signal }))) return;
		const draft = await loadLspDraft(agentDir, project);
		const hasEditedDraft =
			draft !== undefined && JSON.stringify(draft.draft.profile) !== JSON.stringify(active.profile);
		if (hasEditedDraft)
			throw new Error("An edited LSP draft is pending; approve or discard it before changing enabled state");
		await saveLspDraft(
			agentDir,
			project,
			{ ...active.profile, enabled: action === "on" },
			active.revision,
			draft?.revision ?? null,
		);
		await approveLspDraft(agentDir, project, (await loadLspDraft(agentDir, project))!.revision);
		if (disablesPendingCheck) ports.waivePendingLsp();
		await ports.reload(signal);
		return;
	}
	throw new Error("Usage: /quality lsp [setup|status|doctor|restart|on|off]");
}
