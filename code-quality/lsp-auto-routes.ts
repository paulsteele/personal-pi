import { posix } from "node:path";
import { digest } from "./proposal.js";
import { LSP_PRESETS, presetRoute } from "./lsp-presets.js";
import type { LspRoute } from "./lsp-profile.js";
import { WORKSPACE_MARKERS } from "./lsp-setup-defaults.js";

export interface InstalledLanguageTool {
	id: string;
	version: string;
	executable: string;
}

export type AutomaticRouteResult =
	| { kind: "route"; route: LspRoute }
	| { kind: "not-applicable" }
	| { kind: "unavailable"; reason: string };

function containsFile(root: string, file: string): boolean {
	return root === "." || file.startsWith(`${root}/`);
}

function nearestContainingRoot(markers: string[], file: string): string | undefined {
	return markers
		.map((marker) => posix.dirname(marker))
		.filter((root) => containsFile(root, file))
		.sort((left, right) => right.length - left.length)[0];
}

function csharpProject(file: string, files: string[]): { root: string; project: string } | undefined {
	const solutions = files.filter(
		(candidate) => /\.slnx?$/.test(candidate) && containsFile(posix.dirname(candidate), file),
	);
	const nearestSolutionRoot = nearestContainingRoot(solutions, file);
	const applicableSolutions = solutions.filter(
		(candidate) => posix.dirname(candidate) === nearestSolutionRoot,
	);
	if (applicableSolutions.length === 1 && applicableSolutions[0] && nearestSolutionRoot) {
		return { root: nearestSolutionRoot, project: posix.basename(applicableSolutions[0]) };
	}
	if (applicableSolutions.length > 1) {
		return undefined;
	}
	const projects = files.filter(
		(candidate) => candidate.endsWith(".csproj") && containsFile(posix.dirname(candidate), file),
	);
	const nearestProjectRoot = nearestContainingRoot(projects, file);
	const applicableProjects = projects.filter((candidate) => posix.dirname(candidate) === nearestProjectRoot);
	if (applicableProjects.length === 1 && applicableProjects[0] && nearestProjectRoot) {
		return { root: nearestProjectRoot, project: posix.basename(applicableProjects[0]) };
	}
	return undefined;
}

export function automaticLspRoute(options: {
	file: string;
	files: string[];
	tools: readonly InstalledLanguageTool[];
	truncated?: boolean;
}): AutomaticRouteResult {
	const preset = LSP_PRESETS.find((candidate) =>
		Object.keys(candidate.extensions).some((extension) => options.file.endsWith(extension)),
	);
	if (!preset) {
		return { kind: "not-applicable" };
	}
	const tool = options.tools.find((candidate) => candidate.id === preset.id);
	if (!tool) {
		return {
			kind: "unavailable",
			reason: `Provisioned ${preset.id} is missing; rebuild the sandbox toolset`,
		};
	}
	if (options.truncated) {
		return {
			kind: "unavailable",
			reason: "Workspace discovery was truncated; configure an explicit LSP workspace override",
		};
	}
	let root = ".";
	let project: string | undefined;
	if (preset.id === "roslyn") {
		const selected = csharpProject(options.file, options.files);
		if (!selected) {
			return {
				kind: "unavailable",
				reason: "C# solution/project is missing or ambiguous; configure a private workspace override",
			};
		}
		root = selected.root;
		project = selected.project;
	} else if (preset.id === "gopls") {
		const workspaces = options.files.filter((file) => posix.basename(file) === "go.work");
		const modules = options.files.filter((file) => posix.basename(file) === "go.mod");
		const selected =
			nearestContainingRoot(workspaces, options.file) ?? nearestContainingRoot(modules, options.file);
		if (!selected) {
			return { kind: "unavailable", reason: "Go source has no containing go.work or go.mod" };
		}
		root = selected;
	} else {
		const markers = options.files.filter((file) =>
			WORKSPACE_MARKERS[preset.id].includes(posix.basename(file)),
		);
		const selected = nearestContainingRoot(markers, options.file);
		if (preset.id === "rust-analyzer" && !selected) {
			return { kind: "unavailable", reason: "Rust source has no containing Cargo.toml" };
		}
		root = selected ?? ".";
	}
	const suffix = root === "." ? "root" : root.replace(/[^a-zA-Z0-9_-]/g, "-");
	const identity = digest(JSON.stringify([preset.id, posix.normalize(root)]));
	const id = `auto-${preset.id}-${suffix.slice(0, 24)}-${identity.slice(0, 24)}`;
	const route = presetRoute(preset, tool.executable, preset.id, root);
	route.id = id;
	route.version = tool.version;
	if (project) {
		route.project = project;
	}
	return { kind: "route", route };
}
