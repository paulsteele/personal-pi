import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalPath, inside } from "./capture.js";
import { installLsp, installationPlan, installedManagedExecutable } from "./lsp-install.js";
import { findExecutable, LSP_PRESETS, presetRoute } from "./lsp-presets.js";
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

async function chooseRoute(
	ctx: ExtensionContext,
	project: LspProject,
	agentDir: string,
	files: string[],
	existingIds: Set<string>,
	signal: AbortSignal,
	ports: LspSetupPorts,
): Promise<LspRoute | "finished" | undefined> {
	const labels = LSP_PRESETS.map((preset) => {
		const detected = files.some((file) =>
			Object.keys(preset.extensions).some((extension) => file.endsWith(extension)),
		);
		return `${preset.label}${detected ? " (detected)" : ""}`;
	});
	const choice = await ctx.ui.select(
		"Add a language server",
		[...labels, "Custom stdio server", "Finish configuration"],
		{ signal },
	);
	if (!choice) return undefined;
	if (choice === "Finish configuration") return "finished";
	const rootInput = await ctx.ui.input("Workspace root relative to project", ".", { signal });
	if (rootInput === undefined) return undefined;
	const root = approvedWorkspace(project, rootInput || ".");
	const preset = LSP_PRESETS[labels.indexOf(choice)];
	let route: LspRoute;
	if (preset) {
		const managed = await installedManagedExecutable(agentDir, preset);
		const detected = managed ?? (await findExecutable(preset.executable, project.root));
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
	const requestedId = await ctx.ui.input("Unique server route name", route.id, { signal });
	if (requestedId === undefined) return undefined;
	route.id = requestedId || route.id;
	if (existingIds.has(route.id))
		throw new Error(`Route ${route.id} already exists; edit the draft to replace it`);
	if (route.preset === "roslyn") {
		const projects = files.filter(
			(file) =>
				/\.(csproj|sln|slnx)$/.test(file) && inside(resolve(project.root, root), resolve(project.root, file)),
		);
		const selected =
			projects.length === 1
				? projects[0]
				: await ctx.ui.select("C# solution/project", [...projects, "Enter relative path"], { signal });
		if (!selected) return undefined;
		const path =
			selected === "Enter relative path"
				? await ctx.ui.input("Project path relative to workspace", undefined, { signal })
				: relative(resolve(project.root, root), resolve(project.root, selected));
		if (!path) return undefined;
		route.project = path;
	}
	return route;
}

export async function approveLspSetup(
	ctx: ExtensionContext,
	agentDir: string,
	project: LspProject,
	ports: LspSetupPorts,
	signal: AbortSignal,
): Promise<StoredLspProfile | undefined> {
	const pending = await loadLspDraft(agentDir, project);
	if (!pending) throw new Error("No LSP draft. Run /quality lsp setup first.");
	if (!ctx.isProjectTrusted()) throw new Error("Trust this project before starting its language servers");
	const summary = pending.draft.profile.routes.map(routeSummary).join("\n\n");
	const consent = await ctx.ui.confirm(
		"Run language-server validation?",
		`${summary}\n\nThese local processes can read project dependencies, run analyzers/build tooling, access inherited environment, and write caches. No formatting or server-requested edits will be applied.`,
		{ signal },
	);
	if (!consent) return undefined;
	for (const route of pending.draft.profile.routes) {
		ports.progress(`Validating ${route.id}`);
		const validation = await ports.validate(route, project, signal);
		if (!validation.ready) throw new Error(`${route.id}: ${validation.summary}`);
		ctx.ui.notify(`${route.id}: ${validation.summary}`, "info");
	}
	if (
		!(await ctx.ui.confirm(
			"Activate LSP quality checking?",
			`${summary}\n\nAll reported diagnostic severities will enter the existing quality correction flow. This approves future background analysis for this project.`,
			{ signal },
		))
	)
		return undefined;
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
	if (mode === "approve") return approveLspSetup(ctx, agentDir, project, ports, signal);
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
	while (!signal.aborted) {
		const route = await chooseRoute(
			ctx,
			project,
			agentDir,
			discovery.files,
			new Set(profile.routes.map((route) => route.id)),
			signal,
			ports,
		);
		if (route === undefined) return undefined;
		if (route === "finished") break;
		profile.routes.push(route);
	}
	signal.throwIfAborted();
	await saveLspDraft(agentDir, project, profile, baseRevision, pending?.revision ?? null);
	return approveLspSetup(ctx, agentDir, project, ports, signal);
}
