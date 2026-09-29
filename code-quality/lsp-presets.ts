import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { lspStorageRoot, type LspPreset, type LspRoute } from "./lsp-profile.js";

export interface LspPresetDefinition {
	id: Exclude<LspPreset, "custom">;
	label: string;
	version: string;
	executable: string;
	args: string[];
	extensions: Record<string, string>;
	settings: Record<string, unknown>;
	initializationOptions: Record<string, unknown>;
	prerequisites: string[];
	installation: "npm" | "dotnet" | "go" | "rust-component";
	packages: string[];
	installationNotice: string;
}

export const LSP_PRESETS: readonly LspPresetDefinition[] = [
	{
		id: "roslyn",
		label: "C# — Roslyn",
		version: "5.12.0-1.26426.8",
		executable: "roslyn-language-server",
		args: ["--stdio", "--telemetryLevel", "off"],
		extensions: { ".cs": "csharp" },
		settings: {
			"csharp|background_analysis": {
				dotnet_analyzer_diagnostics_scope: "openFiles",
				dotnet_compiler_diagnostics_scope: "openFiles",
			},
		},
		initializationOptions: {},
		prerequisites: ["dotnet"],
		installation: "dotnet",
		packages: ["roslyn-language-server"],
		installationNotice:
			"Prerelease Roslyn server; requires .NET 10. Project loading may restore dependencies and execute analyzers. Select a solution or project explicitly.",
	},
	{
		id: "typescript",
		label: "TypeScript / JavaScript",
		version: "6.0.1",
		executable: "typescript-language-server",
		args: ["--stdio"],
		extensions: {
			".ts": "typescript",
			".tsx": "typescriptreact",
			".js": "javascript",
			".jsx": "javascriptreact",
			".mts": "typescript",
			".cts": "typescript",
			".mjs": "javascript",
			".cjs": "javascript",
		},
		settings: {},
		initializationOptions: {},
		prerequisites: ["node", "npm"],
		installation: "npm",
		packages: ["typescript-language-server@6.0.1", "typescript@5.9.3"],
		installationNotice:
			"Requires Node >=22.22.2. Uses project TypeScript when present; the managed fallback is TypeScript 5.9.3. Syntax, semantic, and suggestion diagnostics are checked.",
	},
	{
		id: "pyright",
		label: "Python — Pyright",
		version: "1.1.414",
		executable: "pyright-langserver",
		args: ["--stdio"],
		extensions: { ".py": "python", ".pyi": "python" },
		settings: { python: { analysis: { diagnosticMode: "openFilesOnly" } } },
		initializationOptions: {},
		prerequisites: ["node", "npm"],
		installation: "npm",
		packages: ["pyright@1.1.414"],
		installationNotice:
			"Uses the project's Pyright configuration and interpreter settings; does not install Python or project dependencies.",
	},
	{
		id: "rust-analyzer",
		label: "Rust — rust-analyzer",
		version: "1.98.1",
		executable: "rust-analyzer",
		args: [],
		extensions: { ".rs": "rust" },
		settings: { "rust-analyzer": { checkOnSave: false } },
		initializationOptions: { checkOnSave: false },
		prerequisites: ["rustc", "cargo"],
		installation: "rust-component",
		packages: [],
		installationNotice:
			"Requires a compatible Rust toolchain and rust-src. The broker explicitly requests cargo checks; build scripts and proc macros may execute. No SDK is installed by setup.",
	},
	{
		id: "gopls",
		label: "Go — gopls",
		version: "0.23.0",
		executable: "gopls",
		args: ["serve"],
		extensions: { ".go": "go" },
		settings: {},
		initializationOptions: { pullDiagnostics: true },
		prerequisites: ["go"],
		installation: "go",
		packages: ["golang.org/x/tools/gopls@v0.23.0"],
		installationNotice:
			"Builds the pinned gopls with your installed Go toolchain. Project loading can access the module cache and download dependencies according to your Go settings.",
	},
];

export function presetById(id: string): LspPresetDefinition {
	const preset = LSP_PRESETS.find((candidate) => candidate.id === id);
	if (!preset) throw new Error(`Unknown LSP preset: ${id}`);
	return preset;
}

export function managedToolDirectory(agentDir: string, preset: LspPresetDefinition): string {
	return join(
		lspStorageRoot(agentDir),
		"tools",
		preset.id,
		preset.version,
		`${process.platform}-${process.arch}`,
	);
}

export function managedExecutable(directory: string, preset: LspPresetDefinition): string {
	return preset.installation === "npm"
		? join(directory, "node_modules", ".bin", preset.executable)
		: join(directory, "bin", preset.executable);
}

export async function findExecutable(
	command: string,
	cwd: string,
	path = process.env.PATH ?? "",
): Promise<string | undefined> {
	const isExplicitPath = command.includes("/");
	const candidates = isExplicitPath
		? [resolve(cwd, command)]
		: path
				.split(delimiter)
				.filter(Boolean)
				.map((directory) => resolve(cwd, directory, command));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			if ((await stat(candidate)).isFile()) return await realpath(candidate);
		} catch {}
	}
	return undefined;
}

export async function findUnverifiedPresetExecutable(
	agentDir: string,
	preset: LspPresetDefinition,
	cwd: string,
): Promise<string | undefined> {
	const directory = managedToolDirectory(agentDir, preset);
	const candidates = [managedExecutable(directory, preset)];
	if (preset.installation === "dotnet") {
		candidates.push(join(directory, preset.executable));
	}
	for (const candidate of candidates) {
		const executable = await findExecutable(candidate, directory);
		if (executable) {
			return executable;
		}
	}
	return findExecutable(preset.executable, cwd);
}

export function presetRoute(
	preset: LspPresetDefinition,
	command: string,
	id = preset.id,
	root = ".",
): LspRoute {
	return {
		id,
		root,
		preset: preset.id,
		command,
		args: [...preset.args],
		version: preset.version,
		extensions: { ...preset.extensions },
		env: {},
		settings: structuredClone(preset.settings),
		initializationOptions: structuredClone(preset.initializationOptions),
		startupTimeoutMs: 60000,
		diagnosticTimeoutMs: 10000,
	};
}
