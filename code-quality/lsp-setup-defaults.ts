import { dirname, relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inside } from "./capture.js";
import type { LspPresetDefinition } from "./lsp-presets.js";
import type { LspProject } from "./lsp-profile.js";

export function suggestedWorkspaceRoots(preset: LspPresetDefinition, files: string[]): string[] {
	const markers: Record<LspPresetDefinition["id"], readonly string[]> = {
		roslyn: [],
		typescript: ["package.json", "tsconfig.json", "jsconfig.json"],
		pyright: ["pyproject.toml", "pyrightconfig.json", "setup.py"],
		"rust-analyzer": ["Cargo.toml"],
		gopls: ["go.work", "go.mod"],
	};
	const roots = [
		...new Set(files.filter((file) => markers[preset.id].includes(file.split("/").at(-1)!)).map(dirname)),
	];
	if (!roots.length || roots.includes(".")) {
		return ["."];
	}
	return roots.sort().filter((root) => {
		const isNestedUnderAnotherRoot = roots.some(
			(parent) => parent !== root && inside(resolve(parent), resolve(root)),
		);
		return !isNestedUnderAnotherRoot;
	});
}

export async function chooseWorkspaceRoot(
	ctx: ExtensionContext,
	preset: LspPresetDefinition,
	files: string[],
	signal: AbortSignal,
): Promise<string | undefined> {
	const roots = suggestedWorkspaceRoots(preset, files);
	if (roots.length === 1) {
		return roots[0];
	}
	return ctx.ui.select(`Which ${preset.label} workspace should be checked?`, roots, { signal });
}

export async function chooseCsharpProject(
	ctx: ExtensionContext,
	project: LspProject,
	root: string,
	files: string[],
	signal: AbortSignal,
): Promise<string | undefined> {
	const workspace = resolve(project.root, root);
	const candidates = files.filter(
		(file) => /\.(csproj|sln|slnx)$/.test(file) && inside(workspace, resolve(project.root, file)),
	);
	const solutions = candidates.filter((file) => /\.slnx?$/.test(file));
	const preferred = solutions.length ? solutions : candidates;
	if (preferred.length === 1) {
		return relative(workspace, resolve(project.root, preferred[0]!));
	}
	if (preferred.length) {
		const selected = await ctx.ui.select("Which C# solution/project should Roslyn load?", preferred, {
			signal,
		});
		return selected ? relative(workspace, resolve(project.root, selected)) : undefined;
	}
	return ctx.ui.input("No C# project found — enter its path relative to the workspace", undefined, {
		signal,
	});
}

export function nextRouteId(presetId: string, root: string, existingIds: Set<string>): string {
	const suffix = root === "." ? "" : `-${root.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
	const base = `${presetId}${suffix}`.slice(0, 70);
	let id = base;
	let number = 2;
	while (existingIds.has(id)) {
		id = `${base}-${number++}`;
	}
	return id;
}
