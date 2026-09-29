import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import type { Diagnostic, InitializeResult } from "vscode-languageserver-protocol";
import { LspProbe, type ProbeServer } from "./lsp-probe.js";
import { LspClient } from "./lsp-client.js";
import { presetById, presetRoute } from "./lsp-presets.js";

const execute = promisify(execFile);
const toolRoot =
	process.env.QUALITY_LSP_TOOL_ROOT ?? join(homedir(), ".pi/agent/extensions/code-quality/tools");
const sdkRoot = join(toolRoot, "compatibility-sdks");
const nodeBin = join(toolRoot, "compatibility-node/node_modules/.bin");
const goBin = join(sdkRoot, "go/1.27.1/go/bin");
const rustBin = join(sdkRoot, "rust/1.98.1/bin");
const enabled = process.env.QUALITY_LSP_PROBE === "1";

interface Scenario {
	server: ProbeServer;
	file: string;
	language: string;
	broken: string;
	fixed: string;
	syntaxError: string;
	nonError: string;
	files: Record<string, string>;
	createdFile: { name: string; broken: string; fixed: string };
	projectContextMethod?: string;
	openProject?: string;
	prepare?: (root: string) => Promise<void>;
	diagnosticProtocol?: "tsserver-sync";
	readiness?: "project-initialized" | "rust-quiescent";
	checkCompletion?: "rust-flycheck";
}

const scenarios: Scenario[] = [
	{
		server: { name: "typescript", command: join(nodeBin, "typescript-language-server"), args: ["--stdio"] },
		diagnosticProtocol: "tsserver-sync",
		file: "index.ts",
		language: "typescript",
		broken: "export function label(): string { return 42; }\n",
		fixed: 'export function label(): string { return "ready"; }\n',
		syntaxError: 'export function label(: string { return "ready"; }\n',
		nonError: 'export function label(unused: string): string { return "ready"; }\n',
		files: { "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }) },
		createdFile: {
			name: "created.ts",
			broken: 'export const count: number = "wrong";\n',
			fixed: "export const count: number = 1;\n",
		},
	},
	{
		server: {
			name: "pyright",
			command: join(nodeBin, "pyright-langserver"),
			args: ["--stdio"],
			settings: { python: { analysis: { typeCheckingMode: "strict", diagnosticMode: "openFilesOnly" } } },
		},
		file: "example.py",
		language: "python",
		broken: "def label() -> str:\n    return 42\n",
		fixed: 'def label() -> str:\n    return "ready"\n',
		syntaxError: 'def label( -> str:\n    return "ready"\n',
		nonError: 'def label() -> str:\n    return "ready"\n    print("unreachable")\n',
		files: { "pyrightconfig.json": JSON.stringify({ typeCheckingMode: "strict" }) },
		createdFile: { name: "created.py", broken: 'count: int = "wrong"\n', fixed: "count: int = 1\n" },
	},
	{
		server: {
			name: "roslyn",
			command: join(toolRoot, "roslyn/5.12.0-1.26426.8/darwin-arm64/roslyn-language-server"),
			args: ["--stdio", "--telemetryLevel", "off"],
			settings: {
				"csharp|background_analysis": {
					dotnet_analyzer_diagnostics_scope: "openFiles",
					dotnet_compiler_diagnostics_scope: "openFiles",
				},
			},
		},
		readiness: "project-initialized",
		projectContextMethod: "textDocument/_vs_getProjectContexts",
		openProject: "Probe.csproj",
		file: "Example.cs",
		language: "csharp",
		broken: "namespace Probe; public static class Example { public static string Label() => 42; }\n",
		fixed: 'namespace Probe; public static class Example { public static string Label() => "ready"; }\n',
		syntaxError: 'namespace Probe; public static class Example { public static string Label( => "ready"; }\n',
		nonError:
			'using System; namespace Probe; public static class Example { public static string Label() => "ready"; }\n',
		files: {
			"Probe.csproj":
				'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>\n',
		},
		createdFile: {
			name: "Created.cs",
			broken: 'namespace Probe; public static class Created { public static int Count() => "wrong"; }\n',
			fixed: "namespace Probe; public static class Created { public static int Count() => 1; }\n",
		},
		prepare: async (root) => {
			await execute("dotnet", ["restore", "Probe.csproj"], { cwd: root, timeout: 60_000 });
		},
	},
	{
		server: {
			name: "gopls",
			command: join(sdkRoot, "gopls/0.23.0/gopls"),
			args: ["serve"],
			initializationOptions: { pullDiagnostics: true },
			env: {
				PATH: `${goBin}:${process.env.PATH}`,
				GOTOOLCHAIN: "local",
				GOPATH: join(sdkRoot, "go-packages"),
				GOCACHE: join(sdkRoot, "go-cache"),
				GOPROXY: "off",
				GOTELEMETRY: "off",
			},
		},
		file: "example.go",
		language: "go",
		broken: "package probe\n\nfunc Label() string { return 42 }\n",
		fixed: 'package probe\n\nfunc Label() string { return "ready" }\n',
		syntaxError: 'package probe\n\nfunc Label( string { return "ready" }\n',
		nonError:
			'package probe\n\nfunc Label() string { return "ready"; println("unreachable"); return "again" }\n',
		files: { "go.mod": "module example.com/probe\n\ngo 1.27\n" },
		createdFile: {
			name: "created.go",
			broken: 'package probe\n\nfunc Count() int { return "wrong" }\n',
			fixed: "package probe\n\nfunc Count() int { return 1 }\n",
		},
	},
	{
		server: {
			name: "rust-analyzer",
			command: join(rustBin, "rust-analyzer"),
			args: [],
			env: {
				PATH: `${rustBin}:${process.env.PATH}`,
				CARGO_HOME: join(sdkRoot, "cargo-home"),
				CARGO_NET_OFFLINE: "true",
			},
			initializationOptions: {
				checkOnSave: false,
				cargo: { buildScripts: { enable: false } },
				procMacro: { enable: false },
			},
			settings: {
				"rust-analyzer": {
					checkOnSave: false,
					cargo: { buildScripts: { enable: false } },
					procMacro: { enable: false },
				},
			},
		},
		readiness: "rust-quiescent",
		checkCompletion: "rust-flycheck",
		file: "lib.rs",
		language: "rust",
		broken: "pub fn label() -> String { 42 }\n",
		fixed: 'pub fn label() -> String { String::from("ready") }\n',
		syntaxError: 'pub fn label( -> String { String::from("ready") }\n',
		nonError: 'pub fn label() -> String { let unused = 1; String::from("ready") }\n',
		files: {
			"Cargo.toml":
				'[package]\nname = "probe"\nversion = "0.1.0"\nedition = "2024"\n[lib]\npath = "lib.rs"\n',
		},
		createdFile: {
			name: "created.rs",
			broken: 'pub fn count() -> i32 { "wrong" }\n',
			fixed: "pub fn count() -> i32 { 1 }\n",
		},
	},
];

async function awaitProjectMembership(probe: LspProbe, method: string, uri: string): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (performance.now() < deadline) {
		const projectContext = await probe.request<{
			_vs_projectContexts?: { _vs_is_miscellaneous?: boolean }[];
		} | null>(method, { _vs_textDocument: { uri } });
		const belongsToLoadedProject = projectContext?._vs_projectContexts?.some(
			(project) => !project._vs_is_miscellaneous,
		);
		if (belongsToLoadedProject) return;
		await sleep(100);
	}
	throw new Error(`Document never joined its loaded project: ${uri}`);
}

async function fileDiagnostics(
	probe: LspProbe,
	scenario: Scenario,
	initialization: InitializeResult,
	file = scenario.file,
): Promise<Diagnostic[]> {
	const uri = pathToFileURL(join(probe.root, file)).href;
	if (scenario.projectContextMethod) await awaitProjectMembership(probe, scenario.projectContextMethod, uri);
	if (scenario.checkCompletion === "rust-flycheck") {
		const eventStart = probe.events.length;
		await probe.connection.sendNotification("rust-analyzer/runFlycheck", { textDocument: { uri } });
		await probe.waitUntil("fresh cargo check completion", () => {
			const started = new Set<string>();
			for (const event of probe.events.slice(eventStart)) {
				const progress = event.params as { token?: string; value?: { kind: string } };
				if (event.method !== "$/progress" || !progress.token?.startsWith("rust-analyzer/flycheck/")) continue;
				if (progress.value?.kind === "begin") started.add(progress.token);
				if (progress.value?.kind === "end" && started.has(progress.token)) return true;
			}
			return false;
		});
	}
	if (scenario.diagnosticProtocol === "tsserver-sync") {
		const diagnostics: Diagnostic[] = [];
		for (const command of [
			"syntacticDiagnosticsSync",
			"semanticDiagnosticsSync",
			"suggestionDiagnosticsSync",
		]) {
			const response = await probe.request<{
				body: {
					text: string;
					category: string;
					code: number;
					start: { line: number; offset: number };
					end: { line: number; offset: number };
				}[];
			}>("workspace/executeCommand", {
				command: "typescript.tsserverRequest",
				arguments: [command, { file: uri }, { expectsResult: true, isAsync: false }],
			});
			for (const item of response.body)
				diagnostics.push({
					message: item.text,
					code: item.code,
					severity: item.category === "error" ? 1 : item.category === "warning" ? 2 : 4,
					range: {
						start: { line: item.start.line - 1, character: item.start.offset - 1 },
						end: { line: item.end.line - 1, character: item.end.offset - 1 },
					},
				});
		}
		return diagnostics;
	}
	await probe.waitUntil(
		"pull diagnostic providers",
		() =>
			Boolean(initialization.capabilities.diagnosticProvider) ||
			[...probe.registrations.values()].some(
				(registration) => registration.method === "textDocument/diagnostic",
			),
	);
	const providers = [...probe.registrations.values()].filter((registration) => {
		if (registration.method !== "textDocument/diagnostic") return false;
		const selectors = registration.registerOptions?.documentSelector as { language?: string }[] | undefined;
		return (
			!selectors ||
			selectors.some((selector) => !selector.language || selector.language === scenario.language)
		);
	});
	const diagnostics: Diagnostic[] = [];
	for (const provider of providers.length
		? providers
		: [{ registerOptions: initialization.capabilities.diagnosticProvider }]) {
		const response = await probe.request<{ kind: string; items: Diagnostic[] }>("textDocument/diagnostic", {
			textDocument: { uri },
			identifier: provider.registerOptions?.identifier,
		});
		diagnostics.push(...response.items);
	}
	if (scenario.checkCompletion === "rust-flycheck") {
		const pushed = probe.events.findLast(
			(event) =>
				event.method === "textDocument/publishDiagnostics" && (event.params as { uri: string }).uri === uri,
		);
		if (pushed) diagnostics.push(...(pushed.params as { diagnostics: Diagnostic[] }).diagnostics);
	}
	return diagnostics;
}

for (const scenario of scenarios) {
	it.skipIf(!enabled)(
		`${scenario.server.name}: production diagnostics client`,
		async () => {
			const parent = join(homedir(), ".pi/agent/extensions/code-quality/compatibility");
			await mkdir(parent, { recursive: true, mode: 0o700 });
			const root = await mkdtemp(join(parent, `client-${scenario.server.name}-`));
			for (const [name, text] of Object.entries(scenario.files)) await writeFile(join(root, name), text);
			const path = join(root, scenario.file);
			await writeFile(path, scenario.broken);
			await scenario.prepare?.(root);
			const route = presetRoute(presetById(scenario.server.name), scenario.server.command);
			route.env = Object.fromEntries(
				Object.entries(scenario.server.env ?? {}).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			);
			route.settings = scenario.server.settings ?? {};
			route.initializationOptions = (scenario.server.initializationOptions as Record<string, unknown>) ?? {};
			route.args = scenario.server.args;
			route.project = scenario.openProject;
			const client = new LspClient(
				route,
				root,
				() => {},
				() => {},
			);
			try {
				await client.start();
				await client.synchronize(path, scenario.language, scenario.broken);
				const brokenDiagnostics = await client.diagnose(path, scenario.language, AbortSignal.timeout(15000));
				expect(brokenDiagnostics.some((finding) => finding.severity === 1)).toBe(true);
				await writeFile(path, scenario.nonError);
				await client.synchronize(path, scenario.language, scenario.nonError);
				const nonErrorDiagnostics = await client.diagnose(
					path,
					scenario.language,
					AbortSignal.timeout(15000),
				);
				expect(
					nonErrorDiagnostics.some((finding) => finding.severity !== undefined && finding.severity > 1),
				).toBe(true);
				await writeFile(path, scenario.fixed);
				await client.synchronize(path, scenario.language, scenario.fixed);
				const fixedDiagnostics = await client.diagnose(path, scenario.language, AbortSignal.timeout(15000));
				expect(fixedDiagnostics).toEqual([]);
			} finally {
				await client.stop();
			}
		},
		120000,
	);

	it.skipIf(!enabled)(
		`${scenario.server.name}: semantic, syntax, non-error, clean, and new-file diagnostics`,
		async () => {
			const parent = join(homedir(), ".pi/agent/extensions/code-quality/compatibility");
			await mkdir(parent, { recursive: true, mode: 0o700 });
			const root = await mkdtemp(join(parent, `${scenario.server.name}-`));
			for (const [name, text] of Object.entries(scenario.files)) await writeFile(join(root, name), text);
			await writeFile(join(root, scenario.file), scenario.broken);
			await scenario.prepare?.(root);
			const probe = new LspProbe(scenario.server, root);
			try {
				const initialization = await probe.initialize();
				if (scenario.openProject) {
					await probe.connection.sendNotification("project/open", {
						projects: [pathToFileURL(join(root, scenario.openProject)).href],
					});
				}
				if (scenario.readiness === "project-initialized") {
					await probe.waitUntil("project initialization", () =>
						probe.events.some((event) => event.method === "workspace/projectInitializationComplete"),
					);
				}
				await probe.sync(scenario.file, scenario.language, scenario.broken);
				if (scenario.readiness === "rust-quiescent") {
					await probe.waitUntil("Rust workspace quiescence", () =>
						probe.events.some(
							(event) =>
								event.method === "experimental/serverStatus" &&
								(event.params as { quiescent: boolean }).quiescent,
						),
					);
				}
				const semanticErrors = await fileDiagnostics(probe, scenario, initialization);
				expect(semanticErrors.some((diagnostic) => diagnostic.severity === 1)).toBe(true);

				await probe.sync(scenario.file, scenario.language, scenario.fixed);
				expect(await fileDiagnostics(probe, scenario, initialization)).toEqual([]);

				await probe.sync(scenario.file, scenario.language, scenario.syntaxError);
				const syntaxErrors = await fileDiagnostics(probe, scenario, initialization);
				expect(syntaxErrors.some((diagnostic) => diagnostic.severity === 1)).toBe(true);

				await probe.sync(scenario.file, scenario.language, scenario.nonError);
				const suggestions = await fileDiagnostics(probe, scenario, initialization);
				probe.record("probe/non-error-findings", suggestions);
				expect(
					suggestions.some((diagnostic) => diagnostic.severity !== undefined && diagnostic.severity > 1),
				).toBe(true);
				expect(suggestions.some((diagnostic) => diagnostic.severity === 1)).toBe(false);

				await probe.sync(scenario.file, scenario.language, scenario.fixed);
				expect(await fileDiagnostics(probe, scenario, initialization)).toEqual([]);
				for (let trailingNewlineCount = 1; trailingNewlineCount <= 5; trailingNewlineCount++) {
					const warmCleanStartedAt = performance.now();
					await probe.sync(
						scenario.file,
						scenario.language,
						`${scenario.fixed}${"\n".repeat(trailingNewlineCount)}`,
					);
					expect(await fileDiagnostics(probe, scenario, initialization)).toEqual([]);
					probe.record("probe/warm-clean", { elapsedMs: performance.now() - warmCleanStartedAt });
				}

				if (scenario.language === "rust") {
					await probe.sync(scenario.file, scenario.language, `pub mod created;\n${scenario.fixed}`);
				}
				await probe.sync(scenario.createdFile.name, scenario.language, scenario.createdFile.broken);
				const createdDiagnostics = await fileDiagnostics(
					probe,
					scenario,
					initialization,
					scenario.createdFile.name,
				);
				expect(createdDiagnostics.some((diagnostic) => diagnostic.severity === 1)).toBe(true);
				await probe.sync(scenario.createdFile.name, scenario.language, scenario.createdFile.fixed);
				expect(await fileDiagnostics(probe, scenario, initialization, scenario.createdFile.name)).toEqual([]);
				console.log(`${scenario.server.name} trace: ${root}/probe-trace.json`);
			} finally {
				await probe.stop();
			}
			expect(probe.events.filter((event) => event.method === "shutdown/error")).toEqual([]);
			expect(probe.child.exitCode).toBe(0);
		},
		120_000,
	);
}
