import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openConfigFile } from "@paulsteele/pi-shared-ui";
import { qualitySandbox, guestLspProjectRoot, type QualitySandbox } from "./sandbox.js";
import {
	loadLspProfile,
	saveLspDraft,
	loadLspDraft,
	lspProfilePath,
	type LspProject,
	type LspProfile,
	type LspRoute,
	type StoredLspProfile,
} from "./lsp-profile.js";
import { LSP_PRESETS, presetRoute, type LspPresetDefinition } from "./lsp-presets.js";
import { approveLspSetup, validateAndActivateLspDraft, type LspSetupPorts } from "./lsp-setup.js";
import { selectLspLanguages } from "./lsp-setup-ui.js";
import {
	chooseCsharpProject,
	chooseWorkspaceRoot,
	languageChoices,
	nextRouteId,
} from "./lsp-setup-defaults.js";
import { discoverSandboxLspFiles } from "./lsp-sandbox-discovery.js";

function provisionedLanguageTool(sandbox: QualitySandbox, preset: LspPresetDefinition) {
	const tool = sandbox.session.environment.toolInventory?.tools.find((entry) => entry.id === preset.id);
	if (!tool) {
		throw new Error(
			`${preset.label} is not provisioned; rebuild the global sandbox toolset before configuring an override`,
		);
	}
	return tool;
}

async function findContainerExecutable(sandbox: QualitySandbox, command: string, signal: AbortSignal) {
	const probe = await sandbox.session.execute({
		command: ["sh", "-c", 'command -v "$1"', "sh", command],
		signal,
	});
	return probe.code === 0 ? probe.output.toString().trim() || undefined : undefined;
}

async function approveContainerLsp(
	ctx: ExtensionContext,
	agentDir: string,
	project: LspProject,
	ports: LspSetupPorts,
	signal: AbortSignal,
	showDetails: boolean,
): Promise<StoredLspProfile | undefined> {
	const pending = await loadLspDraft(agentDir, project);
	if (!pending) {
		throw new Error("No LSP draft. Run /quality lsp setup first.");
	}
	return approveLspSetup(ctx, agentDir, project, ports, signal, { showDetails });
}

async function configureContainerPreset(
	ctx: ExtensionContext,
	sandbox: QualitySandbox,
	project: LspProject,
	preset: LspPresetDefinition,
	files: string[],
	routes: LspRoute[],
	signal: AbortSignal,
	rootOverride?: string,
): Promise<LspRoute | undefined> {
	const root = rootOverride ?? (await chooseWorkspaceRoot(ctx, preset, files, signal));
	if (root === undefined) {
		return undefined;
	}
	let projectPath: string | undefined;
	if (preset.id === "roslyn") {
		projectPath = await chooseCsharpProject(
			ctx,
			{ ...project, root: await guestLspProjectRoot(sandbox, project.root) },
			root,
			files,
			signal,
		);
		if (!projectPath) {
			return undefined;
		}
	}
	const executable = provisionedLanguageTool(sandbox, preset);
	const route = presetRoute(preset, executable.executable, preset.id, root);
	route.id = nextRouteId(preset.id, root, new Set(routes.map((existing) => existing.id)));
	route.version = executable.version;
	if (projectPath) {
		route.project = projectPath;
	}
	return route;
}

async function addAdvancedContainerRoute(
	ctx: ExtensionContext,
	sandbox: QualitySandbox,
	project: LspProject,
	files: string[],
	routes: LspRoute[],
	signal: AbortSignal,
): Promise<LspRoute | undefined> {
	const labels = LSP_PRESETS.map((preset) => preset.label);
	const selected = await ctx.ui.select(
		"Add a container language server",
		[...labels, "Custom stdio server", "Cancel"],
		{ signal },
	);
	if (!selected || selected === "Cancel") {
		return undefined;
	}
	const root = await ctx.ui.input("Workspace root relative to mapped project", ".", { signal });
	if (root === undefined) {
		return undefined;
	}
	const preset = LSP_PRESETS[labels.indexOf(selected)];
	if (preset) {
		return configureContainerPreset(ctx, sandbox, project, preset, files, routes, signal, root || ".");
	}
	const commandInput = await ctx.ui.input(
		"Language server executable inside the devcontainer",
		"/absolute/path/to/server",
		{ signal },
	);
	if (!commandInput) {
		return undefined;
	}
	const command = await findContainerExecutable(sandbox, commandInput, signal);
	if (!command) {
		throw new Error(`Container executable not found: ${commandInput}`);
	}
	const args = await ctx.ui.input("Arguments as a JSON array", '["--stdio"]', { signal });
	const extensions = await ctx.ui.input("File extensions to LSP language IDs as JSON", '{".cs":"csharp"}', {
		signal,
	});
	if (args === undefined || extensions === undefined) {
		return undefined;
	}
	return {
		id: nextRouteId("custom", root || ".", new Set(routes.map((route) => route.id))),
		root: root || ".",
		preset: "custom",
		command,
		args: JSON.parse(args),
		extensions: JSON.parse(extensions),
		version: "external",
		env: {},
		settings: {},
		initializationOptions: {},
		startupTimeoutMs: 60_000,
		diagnosticTimeoutMs: 10_000,
	};
}

export async function setupSandboxLsp(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	agentDir: string;
	project: LspProject;
	mode: "setup" | "edit" | "approve";
	ports: LspSetupPorts;
	signal: AbortSignal;
	activation?: "editor-save" | "confirm";
}): Promise<StoredLspProfile | undefined> {
	const { ctx, agentDir, project, mode, ports, signal } = options;
	if (ctx.mode !== "tui") {
		throw new Error("LSP quality setup requires interactive TUI mode");
	}
	if (!ctx.isProjectTrusted()) {
		throw new Error("Trust this project before configuring its language servers");
	}
	if (mode === "approve") {
		return approveContainerLsp(ctx, agentDir, project, ports, signal, true);
	}
	const active = await loadLspProfile(agentDir, project);
	const pending = await loadLspDraft(agentDir, project);
	const pendingIsActive =
		pending && active && JSON.stringify(pending.draft.profile) === JSON.stringify(active.profile);
	const baseRevision = pending && !pendingIsActive ? pending.draft.baseRevision : (active?.revision ?? null);
	const profile: LspProfile = pending?.draft.profile ??
		active?.profile ?? {
			version: 1,
			projectId: project.id,
			enabled: true,
			routes: [],
		};
	if (mode === "edit") {
		const path =
			pending && !pendingIsActive
				? lspProfilePath(agentDir, project, true)
				: await saveLspDraft(agentDir, project, profile, baseRevision, pending?.revision ?? null);
		await openConfigFile(ctx, path, signal);
		if (options.activation === "editor-save") {
			const edited = (await loadLspDraft(agentDir, project))!;
			return validateAndActivateLspDraft(ctx, agentDir, project, ports, signal, edited.revision);
		}
		ctx.ui.notify(
			`Draft saved at ${path}. Run /quality lsp setup approve to validate and activate it. Executables must exist inside the devcontainer.`,
			"info",
		);
		return undefined;
	}
	const sandbox = qualitySandbox(options.pi);
	ports.progress("Detecting languages inside Podman");
	const projectGuestRoot = await guestLspProjectRoot(sandbox, project.root);
	const discovery = await discoverSandboxLspFiles(sandbox, signal, projectGuestRoot);
	if (discovery.truncated) {
		ctx.ui.notify(
			"Language discovery reached its limit; choose any missing server/root manually.",
			"warning",
		);
	}
	const selection = await (ports.selectLanguages ?? selectLspLanguages)(
		ctx,
		languageChoices(discovery.files, profile),
		signal,
	);
	if (!selection) {
		return undefined;
	}
	const advancedAction =
		selection.action === "advanced"
			? await ctx.ui.select(
					"Advanced container LSP setup",
					["Add a server with custom options", "Edit configuration file", "Cancel"],
					{ signal },
				)
			: undefined;
	if (
		selection.action === "advanced" &&
		advancedAction !== "Add a server with custom options" &&
		advancedAction !== "Edit configuration file"
	) {
		return undefined;
	}
	profile.routes = profile.routes.filter((route) => selection.selected.includes(route.preset));
	if (profile.mode === "auto") {
		profile.disabledLanguages = LSP_PRESETS.filter((preset) => !selection.selected.includes(preset.id)).map(
			(preset) => preset.id,
		);
	}
	if (advancedAction === "Add a server with custom options") {
		const route = await addAdvancedContainerRoute(
			ctx,
			sandbox,
			project,
			discovery.files,
			profile.routes,
			signal,
		);
		if (!route) {
			return undefined;
		}
		profile.routes.push(route);
	}
	for (const preset of LSP_PRESETS.filter((preset) => selection.selected.includes(preset.id))) {
		if (profile.routes.some((route) => route.preset === preset.id)) {
			continue;
		}
		const route = await configureContainerPreset(
			ctx,
			sandbox,
			project,
			preset,
			discovery.files,
			profile.routes,
			signal,
		);
		if (!route) {
			return undefined;
		}
		profile.routes.push(route);
	}

	profile.enabled = profile.routes.length > 0;
	signal.throwIfAborted();
	const path = await saveLspDraft(agentDir, project, profile, baseRevision, pending?.revision ?? null);
	if (advancedAction === "Edit configuration file") {
		await openConfigFile(ctx, path, signal);
		if (options.activation === "editor-save") {
			const edited = (await loadLspDraft(agentDir, project))!;
			return validateAndActivateLspDraft(ctx, agentDir, project, ports, signal, edited.revision);
		}
		ctx.ui.notify(
			`Draft saved at ${path}. Run /quality lsp setup approve to validate and activate it. Executables must exist inside the devcontainer.`,
			"info",
		);
		return undefined;
	}
	if (options.activation === "editor-save") {
		const edited = (await loadLspDraft(agentDir, project))!;
		return validateAndActivateLspDraft(ctx, agentDir, project, ports, signal, edited.revision);
	}
	return approveContainerLsp(ctx, agentDir, project, ports, signal, selection.action === "advanced");
}
