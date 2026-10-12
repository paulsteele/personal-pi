import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { discoverSandboxLspFiles } from "./lsp-sandbox-discovery.js";
import { setupSandboxLsp } from "./lsp-sandbox-setup.js";
import {
	approveLspDraft,
	loadLspDraft,
	loadLspProfile,
	resolveLspProject,
	saveLspDraft,
} from "./lsp-profile.js";
import { LSP_PRESETS, presetById, presetRoute } from "./lsp-presets.js";
import type { LspSetupPorts } from "./lsp-setup.js";
import type { QualitySandbox, QualitySandboxExecuteOptions } from "./sandbox.js";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function executeDiscovery(options: QualitySandboxExecuteOptions) {
	return new Promise<{ output: Buffer; stderr: string; code: number }>((resolve, reject) => {
		const child = spawn(options.command[0]!, options.command.slice(1), {
			cwd: options.cwd,
			signal: options.signal,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (code) =>
			resolve({ output: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString(), code: code ?? 1 }),
		);
		child.stdin.end(options.input);
	});
}

async function setupFixture(files: string[], confirmations: boolean[] = []) {
	const directory = await mkdtemp(join(tmpdir(), "container-lsp-setup-"));
	directories.push(directory);
	const hostRoot = join(directory, "host-project");
	const guestRoot = join(directory, "guest-workspace");
	const agentDir = join(directory, "agent");
	await mkdir(hostRoot);
	await mkdir(guestRoot);
	await writeFile(join(hostRoot, "host-only.go"), "package main\n");
	for (const file of files) {
		await mkdir(dirname(join(guestRoot, file)), { recursive: true });
		await writeFile(join(guestRoot, file), "");
	}
	const project = await resolveLspProject(hostRoot, agentDir);
	const execute = vi.fn(async (options: QualitySandboxExecuteOptions) => {
		if (options.command[0] === "python3") {
			return executeDiscovery(options);
		}
		const command = options.command.at(-1)!;
		return {
			output: Buffer.from(command.includes("/") ? "" : `/usr/bin/${command}\n`),
			stderr: "",
			code: command.includes("/") ? 1 : 0,
		};
	});
	const applyImageTools = vi.fn(async () => {});
	const planImageTools = vi.fn(async () => ({
		preview: "Active devcontainer image proposal",
		apply: applyImageTools,
	}));
	const sandbox: QualitySandbox = {
		planImageTools,
		sessionId: "session",
		revision: () => "revision",
		session: {
			generation: 1,
			processSupervisor: "fixture supervisor",
			environment: {
				container: "container",
				user: "root",
				workspace: guestRoot,
				configuration: {},
				toolInventory: {
					version: 1,
					revision: "fixture-inventory",
					tools: LSP_PRESETS.map((preset) => ({
						id: preset.id,
						version: preset.version,
						executable: `/opt/pi-tools/${preset.id}/${preset.version}/bin/${preset.executable}`,
					})),
				},
			},
			filesystem: {
				canonical: async (path) => path,
				read: async () => Buffer.alloc(0),
				write: async () => {},
				mkdir: async () => {},
				stat: async () => ({ file: true, directory: false, size: 0 }),
				list: async () => [],
			},
			execute,
		},
	};
	const pi = {
		events: {
			emit: vi.fn((channel, request) => {
				if (channel === "sandbox:service:v1") {
					request.accept(sandbox);
				}
			}),
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: hostRoot,
		mode: "tui",
		isProjectTrusted: () => true,
		ui: {
			confirm: vi.fn(async () => confirmations.shift() ?? false),
			notify: vi.fn(),
			select: vi.fn(),
			input: vi.fn(),
		},
	} as unknown as ExtensionContext;
	const ports: LspSetupPorts = {
		validate: vi.fn(async () => ({ ready: true, summary: "Server starts inside Podman" })),
		progress: vi.fn(),
		selectLanguages: vi.fn(async () => undefined),
	};
	const options = {
		pi,
		ctx,
		agentDir,
		project,
		mode: "setup" as const,
		ports,
		signal: new AbortController().signal,
	};
	return { ...options, options, guestRoot, hostRoot, sandbox, execute, planImageTools, applyImageTools };
}

it("detects supported languages only from the guest workspace and preselects them on first setup", async () => {
	const fixture = await setupFixture([
		"src/App.cs",
		"App.sln",
		"web/app.ts",
		"web/tsconfig.json",
		"api/app.py",
		"src/lib.rs",
		"cmd/main.go",
	]);
	await setupSandboxLsp(fixture.options);
	expect(fixture.ports.selectLanguages).toHaveBeenCalledWith(
		fixture.ctx,
		[
			{ id: "roslyn", label: "C# — Roslyn", description: "Detected in this project", selected: true },
			{
				id: "typescript",
				label: "TypeScript / JavaScript",
				description: "Detected in this project",
				selected: true,
			},
			{ id: "pyright", label: "Python — Pyright", description: "Detected in this project", selected: true },
			{
				id: "rust-analyzer",
				label: "Rust — rust-analyzer",
				description: "Detected in this project",
				selected: true,
			},
			{ id: "gopls", label: "Go — gopls", description: "Detected in this project", selected: true },
		],
		fixture.signal,
	);
	expect(fixture.execute).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ cwd: fixture.guestRoot, signal: fixture.signal }),
	);
	expect(fixture.ctx.ui.select).not.toHaveBeenCalled();
	expect(await loadLspDraft(fixture.agentDir, fixture.project)).toBeUndefined();
});

it("opens the real language checklist when setup ports do not override the picker", async () => {
	const fixture = await setupFixture(["app.ts", "app.py"]);
	const lines: string[] = [];
	fixture.ctx.ui.custom = vi.fn(
		async (factory) =>
			new Promise((resolve) => {
				const component = factory(
					{ requestRender: vi.fn() } as never,
					{ fg: (_color: string, text: string) => text } as never,
					{} as never,
					resolve as never,
				);
				lines.push(...(component as { render(width: number): string[] }).render(100));
				resolve(undefined);
			}),
	) as ExtensionContext["ui"]["custom"];
	await setupSandboxLsp({
		...fixture.options,
		ports: { validate: fixture.ports.validate, progress: fixture.ports.progress },
	});
	expect(lines.join("\n")).toContain("[x] TypeScript / JavaScript");
	expect(lines.join("\n")).toContain("[x] Python — Pyright");
	expect(lines.join("\n")).not.toContain("Go — gopls");
});

it("does not suggest a language found only in an unmounted host file", async () => {
	const fixture = await setupFixture(["app.ts"]);
	await setupSandboxLsp(fixture.options);
	expect(fixture.ports.selectLanguages).toHaveBeenCalledWith(
		fixture.ctx,
		[
			{
				id: "typescript",
				label: "TypeScript / JavaScript",
				description: "Detected in this project",
				selected: true,
			},
		],
		fixture.signal,
	);
});

it("falls back to directory discovery when guest Git metadata is unavailable and excludes dependencies and symlinks", async () => {
	const fixture = await setupFixture([
		"app.ts",
		"backend/app.py",
		"node_modules/library/index.go",
		"target/generated.rs",
		".venv/pkg/import.py",
		".git/config",
	]);
	await symlink(fixture.hostRoot, join(fixture.guestRoot, "external"));
	await symlink("app.ts", join(fixture.guestRoot, "linked.ts"));
	expect(await discoverSandboxLspFiles(fixture.sandbox, fixture.signal)).toMatchObject({
		files: ["app.ts", "backend/app.py"],
		truncated: false,
	});
});

it("uses guest Git candidates to ignore generated files and prioritize source files under the discovery budget", async () => {
	const fixture = await setupFixture([
		"src/app.ts",
		"ignored.py",
		".gitignore",
		"aaa-data.txt",
		"zzz-data.txt",
	]);
	await writeFile(join(fixture.guestRoot, ".gitignore"), "ignored.py\n");
	await promisify(execFile)("git", ["init", "--quiet"], { cwd: fixture.guestRoot });
	await promisify(execFile)("git", ["add", "src/app.ts"], { cwd: fixture.guestRoot });
	fixture.execute.mockImplementation(async (options) => {
		const input = JSON.parse(options.input!.toString());
		return executeDiscovery({ ...options, input: Buffer.from(JSON.stringify({ ...input, entryLimit: 1 })) });
	});
	expect(await discoverSandboxLspFiles(fixture.sandbox, fixture.signal)).toMatchObject({
		files: ["src/app.ts"],
		truncated: true,
	});
});

it("includes source from initialized guest submodules", async () => {
	const fixture = await setupFixture(["modules/backend/app.py"]);
	const git = (cwd: string, args: string[]) => promisify(execFile)("git", args, { cwd });
	await git(fixture.guestRoot, ["init", "--quiet"]);
	const submodule = join(fixture.guestRoot, "modules/backend");
	await git(submodule, ["init", "--quiet"]);
	await git(submodule, ["add", "app.py"]);
	await git(submodule, [
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"--quiet",
		"-m",
		"fixture",
	]);
	await git(fixture.guestRoot, ["add", "modules/backend"]);
	expect(await discoverSandboxLspFiles(fixture.sandbox, fixture.signal)).toMatchObject({
		files: ["modules/backend/app.py"],
		truncated: false,
	});
});

it("warns when guest discovery reaches its entry budget", async () => {
	const fixture = await setupFixture(["app.ts"]);
	fixture.execute.mockResolvedValue({
		output: Buffer.from(JSON.stringify({ files: ["app.ts"], truncated: true })),
		stderr: "",
		code: 0,
	});
	await setupSandboxLsp(fixture.options);
	expect(fixture.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
		"Language discovery reached its limit; choose any missing server/root manually.",
		"warning",
	);
});

it("configures multiple detected languages with inferred guest roots and approves them in the same flow", async () => {
	const fixture = await setupFixture(
		["web/app.ts", "web/tsconfig.json", "backend/app.py", "backend/pyproject.toml"],
		[true],
	);
	fixture.ports.selectLanguages = vi.fn(async () => ({
		action: "continue" as const,
		selected: ["typescript", "pyright"],
	}));
	const approved = await setupSandboxLsp(fixture.options);
	expect(approved?.profile.routes.map(({ id, root, command }) => ({ id, root, command }))).toEqual([
		{
			id: "typescript-web",
			root: "web",
			command: "/opt/pi-tools/typescript/6.0.1/bin/typescript-language-server",
		},
		{
			id: "pyright-backend",
			root: "backend",
			command: "/opt/pi-tools/pyright/1.1.414/bin/pyright-langserver",
		},
	]);
	expect(fixture.ports.validate).toHaveBeenCalledTimes(2);
	expect(fixture.ctx.ui.confirm).toHaveBeenCalledExactlyOnceWith(
		"Validate and enable LSP checking?",
		expect.any(String),
		{ signal: fixture.signal },
	);
	expect((await loadLspProfile(fixture.agentDir, fixture.project))?.profile).toEqual(approved?.profile);
});

it("configures a provisioned server without proposing or rebuilding an image", async () => {
	const fixture = await setupFixture(["app.py"], [true]);
	fixture.ports.selectLanguages = vi.fn(async () => ({ action: "continue" as const, selected: ["pyright"] }));
	const approved = await setupSandboxLsp(fixture.options);
	expect(fixture.planImageTools).not.toHaveBeenCalled();
	expect(fixture.applyImageTools).not.toHaveBeenCalled();
	expect(fixture.ports.validate).toHaveBeenCalledTimes(1);
	expect(approved?.profile.routes[0]?.command).toBe("/opt/pi-tools/pyright/1.1.414/bin/pyright-langserver");
});

it("does not build or activate a proposal when setup approval is declined", async () => {
	const fixture = await setupFixture(["app.py"], [false]);
	fixture.ports.selectLanguages = vi.fn(async () => ({ action: "continue" as const, selected: ["pyright"] }));
	expect(await setupSandboxLsp(fixture.options)).toBeUndefined();
	expect(fixture.applyImageTools).not.toHaveBeenCalled();
	expect(fixture.ports.validate).not.toHaveBeenCalled();
	expect(await loadLspProfile(fixture.agentDir, fixture.project)).toBeUndefined();
});

it("reports missing provisioning without attempting installation", async () => {
	const fixture = await setupFixture(["app.py"], [true]);
	fixture.ports.selectLanguages = vi.fn(async () => ({ action: "continue" as const, selected: ["pyright"] }));
	fixture.sandbox.session.environment.toolInventory = undefined;
	await expect(setupSandboxLsp(fixture.options)).rejects.toThrow("not provisioned");
	expect(fixture.planImageTools).not.toHaveBeenCalled();
	expect(fixture.ports.validate).not.toHaveBeenCalled();
	expect(await loadLspProfile(fixture.agentDir, fixture.project)).toBeUndefined();
});

it("validates an edited override without an image build", async () => {
	const fixture = await setupFixture([], [true]);
	await saveLspDraft(fixture.agentDir, fixture.project, {
		version: 1,
		projectId: fixture.project.id,
		enabled: true,
		routes: [
			presetRoute(
				presetById("pyright"),
				"/opt/pi-quality-tools/pyright/1.1.414/node_modules/.bin/pyright-langserver",
			),
		],
	});
	const approved = await setupSandboxLsp({ ...fixture.options, mode: "approve" });
	expect(approved?.profile.routes[0]?.preset).toBe("pyright");
	expect(fixture.applyImageTools).not.toHaveBeenCalled();
	expect(fixture.ports.validate).toHaveBeenCalledTimes(1);
	expect(fixture.execute).not.toHaveBeenCalled();
});

it("refuses to approve an override changed during confirmation", async () => {
	const fixture = await setupFixture(["app.py"]);
	fixture.ports.selectLanguages = vi.fn(async () => ({ action: "continue" as const, selected: ["pyright"] }));
	fixture.ctx.ui.confirm = vi.fn(async () => {
		const pending = (await loadLspDraft(fixture.agentDir, fixture.project))!;
		pending.draft.profile.routes[0]!.diagnosticTimeoutMs = 20_000;
		await saveLspDraft(fixture.agentDir, fixture.project, pending.draft.profile);
		return true;
	});
	await expect(setupSandboxLsp(fixture.options)).rejects.toThrow();
	expect(fixture.applyImageTools).not.toHaveBeenCalled();
});

it("does not rebuild when the active image recipe already includes the selected tool", async () => {
	const fixture = await setupFixture(["app.py"], [true]);
	fixture.ports.selectLanguages = vi.fn(async () => ({ action: "continue" as const, selected: ["pyright"] }));
	const command = "/opt/pi-tools/pyright/1.1.414/bin/pyright-langserver";
	fixture.sandbox.planImageTools = vi.fn(async () => undefined);
	const approved = await setupSandboxLsp(fixture.options);
	expect(fixture.applyImageTools).not.toHaveBeenCalled();
	expect(fixture.execute).toHaveBeenCalledTimes(1);
	expect(fixture.ctx.ui.confirm).toHaveBeenCalledTimes(1);
	expect(approved?.profile.routes[0]?.command).toBe(command);
});

it("keeps configured languages selected, leaves new languages opt-in, and preserves edited overrides", async () => {
	const fixture = await setupFixture(["app.py"], [true]);
	const route = presetRoute(presetById("typescript"), "/container/server");
	route.env = { CUSTOM: "value" };
	route.diagnosticTimeoutMs = 25_000;
	await saveLspDraft(fixture.agentDir, fixture.project, {
		version: 1,
		projectId: fixture.project.id,
		enabled: true,
		routes: [route],
	});
	fixture.ports.selectLanguages = vi.fn(async () => ({
		action: "continue" as const,
		selected: ["typescript"],
	}));
	const approved = await setupSandboxLsp(fixture.options);
	expect(fixture.ports.selectLanguages).toHaveBeenCalledWith(
		fixture.ctx,
		[
			{
				id: "typescript",
				label: "TypeScript / JavaScript",
				description: "Keep existing configuration",
				selected: true,
			},
			{ id: "pyright", label: "Python — Pyright", description: "Detected in this project", selected: false },
		],
		fixture.signal,
	);
	expect(approved?.profile.routes).toEqual([route]);
	expect(fixture.execute).toHaveBeenCalledTimes(1);
});

it("lists discovered C# solutions before projects and stores the path relative to the guest route root", async () => {
	const fixture = await setupFixture(["App.sln", "src/App.csproj", "src/App.cs"], [true]);
	fixture.ports.selectLanguages = vi.fn(async () => ({ action: "continue" as const, selected: ["roslyn"] }));
	fixture.ctx.ui.select = vi.fn(async () => "App.sln");
	const approved = await setupSandboxLsp(fixture.options);
	expect(fixture.ctx.ui.select).toHaveBeenCalledExactlyOnceWith(
		"Which C# solution/project should Roslyn load?",
		["App.sln", "src/App.csproj", "Enter a relative path"],
		{ signal: fixture.signal },
	);
	expect(approved?.profile.routes[0]?.project).toBe("App.sln");
});

it("persists automatic-language deselection when the wizard retains only TypeScript", async () => {
	const fixture = await setupFixture(["app.ts", "app.py"], [true]);
	await saveLspDraft(fixture.agentDir, fixture.project, {
		version: 1, projectId: fixture.project.id, enabled: true, mode: "auto", disabledLanguages: [],
		routes: [presetRoute(presetById("typescript"), "/container/server")],
	});
	fixture.ports.selectLanguages = vi.fn(async () => ({ action: "continue" as const, selected: ["typescript"] }));
	const approved = await setupSandboxLsp(fixture.options);
	expect(approved?.profile.mode).toBe("auto");
	expect(approved?.profile.disabledLanguages).toContain("pyright");
	expect(approved?.profile.disabledLanguages).not.toContain("typescript");
	expect(approved?.profile.routes.map((route) => route.preset)).toEqual(["typescript"]);
});

it("disables checking without validating servers when every language is deselected", async () => {
	const fixture = await setupFixture(["app.ts"], [true]);
	await saveLspDraft(fixture.agentDir, fixture.project, {
		version: 1,
		projectId: fixture.project.id,
		enabled: true,
		routes: [presetRoute(presetById("typescript"), "/container/server")],
	});
	fixture.ports.selectLanguages = vi.fn(async () => ({ action: "continue" as const, selected: [] }));
	const approved = await setupSandboxLsp(fixture.options);
	expect(approved?.profile).toMatchObject({ enabled: false, routes: [] });
	expect(fixture.ports.validate).not.toHaveBeenCalled();
});

it("leaves the active profile unchanged when validation fails", async () => {
	const fixture = await setupFixture(["app.ts"], [true]);
	fixture.ports.selectLanguages = vi.fn(async () => ({
		action: "continue" as const,
		selected: ["typescript"],
	}));
	fixture.ports.validate = vi.fn(async () => ({ ready: false, summary: "Missing runtime" }));
	await expect(setupSandboxLsp(fixture.options)).rejects.toThrow("Missing runtime");
	expect(await loadLspProfile(fixture.agentDir, fixture.project)).toBeUndefined();
	expect((await loadLspDraft(fixture.agentDir, fixture.project))?.draft.profile.routes).toHaveLength(1);
});

it("does not execute discovery or validation after cancellation or for an untrusted project", async () => {
	const fixture = await setupFixture(["app.ts"]);
	await expect(setupSandboxLsp({ ...fixture.options, signal: AbortSignal.abort() })).rejects.toThrow();
	fixture.ctx.isProjectTrusted = () => false;
	await expect(setupSandboxLsp(fixture.options)).rejects.toThrow("Trust this project");
	expect(fixture.execute).not.toHaveBeenCalled();
	expect(fixture.ports.validate).not.toHaveBeenCalled();
});

it("discovers setup files from the mapped project root when startup is in a subdirectory", async () => {
	const fixture = await setupFixture(["app.py", "subdirectory/README.md"]);
	fixture.sandbox.guestPath = vi.fn(async () => fixture.guestRoot);
	fixture.sandbox.session.environment.workspace = join(fixture.guestRoot, "subdirectory");
	await setupSandboxLsp(fixture.options);
	expect(fixture.sandbox.guestPath).toHaveBeenCalledWith(fixture.hostRoot);
	expect(fixture.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd: fixture.guestRoot }));
	expect(fixture.ports.selectLanguages).toHaveBeenCalledWith(fixture.ctx,
		[{ id: "pyright", label: "Python — Pyright", description: "Detected in this project", selected: true }],
		fixture.signal,
	);
});

it("does not fall back to host discovery when the guest scanner fails", async () => {
	const fixture = await setupFixture([]);
	fixture.execute.mockResolvedValue({
		output: Buffer.alloc(0),
		stderr: "guest python unavailable",
		code: 127,
	});
	await expect(setupSandboxLsp(fixture.options)).rejects.toThrow("guest python unavailable");
	expect(fixture.ports.selectLanguages).not.toHaveBeenCalled();
});

it("allows adding a missing preset through Advanced while keeping checklist selections", async () => {
	const fixture = await setupFixture(["app.ts"], [true]);
	fixture.ports.selectLanguages = vi.fn(async () => ({
		action: "advanced" as const,
		selected: ["typescript"],
	}));
	fixture.ctx.ui.select = vi
		.fn()
		.mockResolvedValueOnce("Add a server with custom options")
		.mockResolvedValueOnce("Python — Pyright");
	fixture.ctx.ui.input = vi.fn(async () => ".");
	const approved = await setupSandboxLsp(fixture.options);
	expect(approved?.profile.routes.map((route) => route.preset)).toEqual(["pyright", "typescript"]);
	expect(fixture.ports.validate).toHaveBeenCalledTimes(2);
});

it("retains an edited draft unchanged when opening setup edit", async () => {
	const fixture = await setupFixture([]);
	const profile = {
		version: 1 as const,
		projectId: fixture.project.id,
		enabled: true,
		routes: [presetRoute(presetById("typescript"), "/container/server")],
	};
	await saveLspDraft(fixture.agentDir, fixture.project, profile);
	await approveLspDraft(
		fixture.agentDir,
		fixture.project,
		(await loadLspDraft(fixture.agentDir, fixture.project))!.revision,
	);
	profile.routes[0]!.env = { EDITED: "yes" };
	await saveLspDraft(fixture.agentDir, fixture.project, profile);
	const pending = await loadLspDraft(fixture.agentDir, fixture.project);
	await setupSandboxLsp({ ...fixture.options, mode: "edit" });
	expect(await loadLspDraft(fixture.agentDir, fixture.project)).toEqual(pending);
	expect(fixture.execute).not.toHaveBeenCalled();
});
