import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalPath, inside } from "./capture.js";
import { installLsp, installationPlan, installedManagedExecutable } from "./lsp-install.js";
import {
	findExecutable,
	findUnverifiedPresetExecutable,
	LSP_PRESETS,
	presetRoute,
	type LspPresetDefinition,
} from "./lsp-presets.js";
import { selectLspLanguages, type LspLanguageChoice } from "./lsp-setup-ui.js";
import { chooseCsharpProject, chooseWorkspaceRoot, nextRouteId } from "./lsp-setup-defaults.js";
import {
	approveLspDraft,
	loadLspDraft,
	loadLspProfile,
	lspProfilePath,
	saveLspDraft,
	type LspProfile,
	type LspProject,
	type LspRoute,
	type StoredLspProfile,
} from "./lsp-profile.js";

export interface LspValidation {
	ready: boolean;
	summary: string;
}
export interface LspSetupPorts {
	validate(route: LspRoute, project: LspProject, signal: AbortSignal): Promise<LspValidation>;
	progress(text: string): void;
	selectLanguages?: typeof selectLspLanguages;
}
export interface ProjectDiscovery {
	files: string[];
	truncated: boolean;
}

export async function discoverLspFiles(root: string, signal: AbortSignal): Promise<ProjectDiscovery> {
	const files: string[] = [];
	const directories = [root];
	const excluded = new Set([".git", "node_modules", "bin", "obj", "target", ".venv", "venv", "vendor"]);
	let inspected = 0;
	while (directories.length) {
		signal.throwIfAborted();
		const directory = directories.pop()!;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (++inspected > 10000) return { files, truncated: true };
			if (entry.isSymbolicLink()) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory() && !excluded.has(entry.name)) directories.push(path);
			else if (entry.isFile()) files.push(relative(root, path));
		}
	}
	return { files: files.sort(), truncated: false };
}

export function routeSummary(route: LspRoute): string {
	return [
		`${route.id}: ${route.preset} ${route.version}`,
		`Workspace: ${route.root}${route.project ? `; project: ${route.project}` : ""}`,
		`Command: ${[route.command, ...route.args].map((arg) => JSON.stringify(arg)).join(" ")}`,
		`Files: ${Object.keys(route.extensions).join(", ")}`,
		`Environment keys: ${Object.keys(route.env).join(", ") || "none"}`,
		`Initialization: ${JSON.stringify(route.initializationOptions)}`,
		`Settings: ${JSON.stringify(route.settings)}`,
	].join("\n");
}

function approvedWorkspace(project: LspProject, root: string): string {
	const resolved = canonicalPath(resolve(project.root, root));
	if (!inside(project.root, resolved))
		throw new Error("LSP workspace must remain inside the approved project");
	return relative(project.root, resolved) || ".";
}

async function chooseAdvancedRoute(
	ctx: ExtensionContext,
	project: LspProject,
	agentDir: string,
	files: string[],
	existingIds: Set<string>,
	signal: AbortSignal,
	ports: LspSetupPorts,
): Promise<LspRoute | undefined> {
	const labels = LSP_PRESETS.map((preset) => {
		const detected = files.some((file) =>
			Object.keys(preset.extensions).some((extension) => file.endsWith(extension)),
		);
		return `${preset.label}${detected ? " (detected)" : ""}`;
	});
	const choice = await ctx.ui.select("Add a language server", [...labels, "Custom stdio server", "Cancel"], {
		signal,
	});
	if (!choice || choice === "Cancel") return undefined;
	const rootInput = await ctx.ui.input("Workspace root relative to project", ".", { signal });
	if (rootInput === undefined) return undefined;
	const root = approvedWorkspace(project, rootInput || ".");
	const preset = LSP_PRESETS[labels.indexOf(choice)];
	let route: LspRoute;
	if (preset) {
		const managed = await installedManagedExecutable(agentDir, preset);
		const detected = managed ?? (await findUnverifiedPresetExecutable(agentDir, preset, project.root));
		const executableChoice = await ctx.ui.select(
			`${preset.label}\n${preset.installationNotice}`,
			[...(detected ? [`Use ${detected}`] : []), "Choose executable path", "Install pinned server privately"],
			{ signal },
		);
		if (!executableChoice) return undefined;
		let command: string;
		let installedPinnedVersion = false;
		if (executableChoice.startsWith("Use ") && detected) command = detected;
		else if (executableChoice === "Choose executable path") {
			const input = await ctx.ui.input("Language server executable", preset.executable, { signal });
			if (!input) return undefined;
			const found = await findExecutable(input, project.root);
			if (!found) throw new Error(`Executable not found: ${input}`);
			command = found;
		} else {
			command = await installLsp(
				installationPlan(agentDir, preset),
				{
					approve: (summary) => ctx.ui.confirm("Install language server?", summary, { signal }),
					progress: ports.progress,
				},
				signal,
			);
			installedPinnedVersion = true;
		}
		route = presetRoute(preset, command, preset.id, root);
		if (!installedPinnedVersion && (!managed || command !== managed))
			route.version = `external; preset tested with ${preset.version}`;
	} else {
		const commandInput = await ctx.ui.input("Custom executable", "/absolute/path/to/server", { signal });
		if (!commandInput) return undefined;
		const command = await findExecutable(commandInput, project.root);
		if (!command) throw new Error(`Executable not found: ${commandInput}`);
		const args = await ctx.ui.input("Arguments as a JSON array", '["--stdio"]', { signal });
		const extensions = await ctx.ui.input("File extensions to LSP language IDs as JSON", '{".cs":"csharp"}', {
			signal,
		});
		if (args === undefined || extensions === undefined) return undefined;
		route = {
			id: "custom",
			root,
			preset: "custom",
			command,
			args: JSON.parse(args),
			version: "external",
			extensions: JSON.parse(extensions),
			env: {},
			settings: {},
			initializationOptions: {},
			startupTimeoutMs: 60000,
			diagnosticTimeoutMs: 10000,
		};
	}
	route.id = nextRouteId(route.preset, root, existingIds);
	if (route.preset === "roslyn") {
		const selected = await chooseCsharpProject(ctx, project, root, files, signal);
		if (!selected) return undefined;
		route.project = selected;
	}
	return route;
}

function languageChoices(files: string[], profile: LspProfile) {
	const configured = new Set(profile.routes.map((route) => route.preset));
	const choices: LspLanguageChoice[] = LSP_PRESETS.flatMap((preset) => {
		const detected = files.some((file) =>
			Object.keys(preset.extensions).some((extension) => file.endsWith(extension)),
		);
		if (!detected && !configured.has(preset.id)) {
			return [];
		}
		const isConfigured = configured.has(preset.id);
		const selectedByDefault = isConfigured || profile.routes.length === 0;
		return [
			{
				id: preset.id,
				label: preset.label,
				description: isConfigured ? "Keep existing configuration" : "Detected in this project",
				selected: selectedByDefault,
			},
		];
	});
	if (configured.has("custom")) {
		choices.push({
			id: "custom",
			label: "Custom servers",
			description: "Keep existing custom configurations",
			selected: true,
		});
	}
	return choices;
}

async function configureDetectedServer(
	ctx: ExtensionContext,
	project: LspProject,
	agentDir: string,
	preset: LspPresetDefinition,
	files: string[],
	routes: LspRoute[],
	ports: LspSetupPorts,
	signal: AbortSignal,
): Promise<LspRoute | undefined> {
	const root = await chooseWorkspaceRoot(ctx, preset, files, signal);
	if (root === undefined) return undefined;
	let projectPath: string | undefined;
	if (preset.id === "roslyn") {
		projectPath = await chooseCsharpProject(ctx, project, root, files, signal);
		if (!projectPath) return undefined;
	}
	const managed = await installedManagedExecutable(agentDir, preset);
	const installedExecutable =
		managed ?? (await findUnverifiedPresetExecutable(agentDir, preset, project.root));
	const executablePath =
		installedExecutable ??
		(await installLsp(
			installationPlan(agentDir, preset),
			{
				approve: (summary) => ctx.ui.confirm("Install missing language server?", summary, { signal }),
				progress: ports.progress,
			},
			signal,
		));
	const id = nextRouteId(preset.id, root, new Set(routes.map((route) => route.id)));
	const route = presetRoute(preset, executablePath, preset.id, root);
	route.id = id;
	if (installedExecutable && !managed) route.version = `external; preset tested with ${preset.version}`;
	if (projectPath) route.project = projectPath;
	return route;
}

export async function approveLspSetup(
	ctx: ExtensionContext,
	agentDir: string,
	project: LspProject,
	ports: LspSetupPorts,
	signal: AbortSignal,
	options: { showDetails?: boolean } = {},
): Promise<StoredLspProfile | undefined> {
	const pending = await loadLspDraft(agentDir, project);
	if (!pending) throw new Error("No LSP draft. Run /quality lsp setup first.");
	if (!ctx.isProjectTrusted()) throw new Error("Trust this project before starting its language servers");
	const summary = pending.draft.profile.routes
		.map((route) => {
			if (options.showDetails) return routeSummary(route);
			const label = LSP_PRESETS.find((preset) => preset.id === route.preset)?.label ?? route.id;
			return `${label} · ${route.root}${route.project ? ` · ${route.project}` : ""}\n${route.command} ${route.args.join(" ")}`;
		})
		.join("\n\n");
	const consent = await ctx.ui.confirm(
		pending.draft.profile.enabled
			? "Validate and enable LSP checking?"
			: "Validate and save disabled LSP configuration?",
		`${summary || "No languages selected; LSP checking will be disabled."}\n\n${pending.draft.profile.enabled ? "Enable automatic checks after validation succeeds. All diagnostic severities enter the quality correction flow." : "Save this configuration with automatic LSP checking disabled."}\nServers can read dependencies, run analyzers/build tooling, and write caches. No formatting or server-requested edits will be applied.`,
		{ signal },
	);
	if (!consent) return undefined;
	for (const route of pending.draft.profile.routes) {
		ports.progress(`Validating ${route.id}`);
		const validation = await ports.validate(route, project, signal);
		if (!validation.ready) throw new Error(`${route.id}: ${validation.summary}`);
	}
	signal.throwIfAborted();
	return approveLspDraft(agentDir, project, pending.revision);
}

export async function setupLsp(
	ctx: ExtensionContext,
	agentDir: string,
	project: LspProject,
	mode: "setup" | "edit" | "approve",
	ports: LspSetupPorts,
	signal: AbortSignal,
): Promise<StoredLspProfile | undefined> {
	if (ctx.mode !== "tui") throw new Error("LSP quality setup requires interactive TUI mode");
	if (!ctx.isProjectTrusted()) throw new Error("Trust this project before configuring its language servers");
	if (mode === "approve")
		return approveLspSetup(ctx, agentDir, project, ports, signal, { showDetails: true });
	const active = await loadLspProfile(agentDir, project);
	const pending = await loadLspDraft(agentDir, project);
	const pendingIsActive =
		pending && active && JSON.stringify(pending.draft.profile) === JSON.stringify(active.profile);
	const baseRevision = pending && !pendingIsActive ? pending.draft.baseRevision : (active?.revision ?? null);
	const profile: LspProfile = pending?.draft.profile ??
		active?.profile ?? { version: 1, projectId: project.id, enabled: true, routes: [] };
	if (mode === "edit") {
		const path =
			pending && !pendingIsActive
				? lspProfilePath(agentDir, project, true)
				: await saveLspDraft(agentDir, project, profile, baseRevision, pending?.revision ?? null);
		ctx.ui.notify(`Edit ${path}, then run /quality lsp setup approve.`, "info");
		return undefined;
	}
	const discovery = await discoverLspFiles(project.root, signal);
	if (discovery.truncated)
		ctx.ui.notify(
			"Language discovery reached its limit; choose any missing server/root manually.",
			"warning",
		);
	const selection = await (ports.selectLanguages ?? selectLspLanguages)(
		ctx,
		languageChoices(discovery.files, profile),
		signal,
	);
	if (!selection) return undefined;
	if (selection.action === "advanced") {
		const advancedSetupAction = await ctx.ui.select(
			"Advanced LSP setup",
			["Add a server with custom options", "Edit configuration file", "Cancel"],
			{ signal },
		);
		if (advancedSetupAction === "Edit configuration file") {
			return setupLsp(ctx, agentDir, project, "edit", ports, signal);
		}
		if (advancedSetupAction !== "Add a server with custom options") return undefined;
		const route = await chooseAdvancedRoute(
			ctx,
			project,
			agentDir,
			discovery.files,
			new Set(profile.routes.map((route) => route.id)),
			signal,
			ports,
		);
		if (!route) return undefined;
		profile.routes.push(route);
		profile.enabled = true;
	} else {
		profile.routes = profile.routes.filter((route) => selection.selected.includes(route.preset));
		for (const preset of LSP_PRESETS.filter((preset) => selection.selected.includes(preset.id))) {
			if (profile.routes.some((route) => route.preset === preset.id)) continue;
			const route = await configureDetectedServer(
				ctx,
				project,
				agentDir,
				preset,
				discovery.files,
				profile.routes,
				ports,
				signal,
			);
			if (!route) return undefined;
			profile.routes.push(route);
		}
		profile.enabled = profile.routes.length > 0;
	}
	signal.throwIfAborted();
	await saveLspDraft(agentDir, project, profile, baseRevision, pending?.revision ?? null);
	return approveLspSetup(ctx, agentDir, project, ports, signal, {
		showDetails: selection.action === "advanced",
	});
}
