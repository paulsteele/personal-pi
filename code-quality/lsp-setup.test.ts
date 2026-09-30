import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { approveLspSetup, discoverLspFiles, setupLsp, type LspSetupPorts } from "./lsp-setup.js";
import { loadLspDraft, loadLspProfile, resolveLspProject, saveLspDraft } from "./lsp-profile.js";
import { managedExecutable, managedToolDirectory, presetById, presetRoute } from "./lsp-presets.js";
import { chooseCsharpProject, nextRouteId, suggestedWorkspaceRoots } from "./lsp-setup-defaults.js";
import { installationPlan, installationSummary } from "./lsp-install.js";
import { handleLspCommand, type LspCommandPorts } from "./lsp-commands.js";
import * as installations from "./lsp-install.js";
import * as presets from "./lsp-presets.js";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function setupFixture(confirmations: boolean[]) {
	const directory = await mkdtemp(join(tmpdir(), "lsp-setup-"));
	directories.push(directory);
	const cwd = join(directory, "project");
	await mkdir(cwd);
	const agentDir = join(directory, "agent");
	const project = await resolveLspProject(cwd, agentDir);
	const route = presetRoute(presetById("typescript"), process.execPath);
	await saveLspDraft(agentDir, project, {
		version: 1,
		projectId: project.id,
		enabled: true,
		routes: [route],
	});
	const confirm = vi.fn(async () => confirmations.shift() ?? false);
	const ctx = {
		cwd,
		mode: "tui",
		isProjectTrusted: () => true,
		ui: { confirm, notify: vi.fn() },
	} as unknown as ExtensionContext;
	const ports: LspSetupPorts = {
		validate: vi.fn(async () => ({ ready: true, summary: "1 existing warning" })),
		progress: vi.fn(),
		selectLanguages: vi.fn(async () => undefined),
	};
	return { ctx, ports, agentDir, project, route, confirm };
}

async function unreceiptedServerFixture(presetId: string, layout: "managed" | "tool-root") {
	const fixture = await setupFixture([true]);
	const preset = presetById(presetId);
	const directory = managedToolDirectory(fixture.agentDir, preset);
	const launcher =
		layout === "tool-root" ? join(directory, preset.executable) : managedExecutable(directory, preset);
	await mkdir(dirname(launcher), { recursive: true });
	const executable = join(dirname(launcher), "server-target");
	await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	await symlink("server-target", launcher);
	await writeFile(join(fixture.project.root, "App.cs"), "class App {}\n");
	await writeFile(join(fixture.project.root, "App.csproj"), "<Project />\n");
	fixture.ctx.ui.select = vi.fn().mockResolvedValue("App.csproj");
	return { ...fixture, preset, directory, executable: await realpath(executable) };
}

it("leaves the draft unchanged when the setup picker is cancelled", async () => {
	const fixture = await setupFixture([]);
	fixture.ctx.ui.select = vi.fn().mockResolvedValue(undefined);
	const initialDraft = await loadLspDraft(fixture.agentDir, fixture.project);
	expect(
		await setupLsp(
			fixture.ctx,
			fixture.agentDir,
			fixture.project,
			"setup",
			fixture.ports,
			new AbortController().signal,
		),
	).toBeUndefined();
	expect(await loadLspDraft(fixture.agentDir, fixture.project)).toEqual(initialDraft);
	expect(fixture.confirm).not.toHaveBeenCalled();
	expect(fixture.ports.validate).not.toHaveBeenCalled();
});

it("does not start validation until local execution is approved", async () => {
	const fixture = await setupFixture([false]);
	expect(
		await approveLspSetup(
			fixture.ctx,
			fixture.agentDir,
			fixture.project,
			fixture.ports,
			new AbortController().signal,
		),
	).toBeUndefined();
	expect(fixture.ports.validate).not.toHaveBeenCalled();
	expect(await loadLspProfile(fixture.agentDir, fixture.project)).toBeUndefined();
});

it("validates before activation and accepts an operational server with existing findings", async () => {
	const fixture = await setupFixture([true, true]);
	const result = await approveLspSetup(
		fixture.ctx,
		fixture.agentDir,
		fixture.project,
		fixture.ports,
		new AbortController().signal,
	);
	expect(fixture.ports.validate).toHaveBeenCalledWith(
		fixture.route,
		fixture.project,
		expect.any(AbortSignal),
	);
	expect(fixture.confirm).toHaveBeenCalledTimes(1);
	expect(fixture.confirm).toHaveBeenCalledWith(
		"Validate and enable LSP checking?",
		expect.any(String),
		expect.any(Object),
	);
	expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
	expect(result?.profile.routes).toEqual([fixture.route]);
	expect((await loadLspProfile(fixture.agentDir, fixture.project))?.revision).toBe(result?.revision);
});

it.each([
	{ ready: true, summary: "Operational; 1 diagnostics in example.ts" },
	{ ready: false, summary: "Missing runtime" },
])("doctor keeps operational summaries quiet and reports unavailable servers: $ready", async (validation) => {
	const fixture = await setupFixture([true, true]);
	const signal = new AbortController().signal;
	await approveLspSetup(fixture.ctx, fixture.agentDir, fixture.project, fixture.ports, signal);
	vi.mocked(fixture.ctx.ui.notify).mockClear();
	const ports: LspCommandPorts = {
		...fixture.ports,
		validate: vi.fn(async () => validation),
		status: () => "typescript · ready",
		restart: vi.fn(),
		reload: vi.fn(),
		hasPendingCase: () => false,
		waivePendingLsp: vi.fn(),
	};
	await handleLspCommand("doctor", fixture.ctx, fixture.agentDir, ports, signal);
	if (validation.ready) {
		expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
	} else {
		expect(fixture.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith("typescript: Missing runtime", "warning");
	}
	vi.mocked(fixture.ctx.ui.notify).mockClear();
	await handleLspCommand("status", fixture.ctx, fixture.agentDir, ports, signal);
	expect(fixture.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith("typescript · ready", "info");
});

it("keeps the draft inactive when validation is cancelled", async () => {
	const fixture = await setupFixture([true]);
	const cancellation = new AbortController();
	fixture.ports.validate = vi.fn(async () => {
		cancellation.abort();
		throw new Error("Validation cancelled");
	});
	await expect(
		approveLspSetup(fixture.ctx, fixture.agentDir, fixture.project, fixture.ports, cancellation.signal),
	).rejects.toThrow("Validation cancelled");
	expect(fixture.ports.validate).toHaveBeenCalledTimes(1);
	expect(await loadLspProfile(fixture.agentDir, fixture.project)).toBeUndefined();
});

it("cannot activate an unavailable server or start setup for an untrusted project", async () => {
	const fixture = await setupFixture([true]);
	fixture.ports.validate = vi.fn(async () => ({ ready: false, summary: "Missing runtime" }));
	await expect(
		approveLspSetup(
			fixture.ctx,
			fixture.agentDir,
			fixture.project,
			fixture.ports,
			new AbortController().signal,
		),
	).rejects.toThrow("Missing runtime");
	expect(fixture.confirm).toHaveBeenCalledTimes(1);
	fixture.ctx.isProjectTrusted = () => false;
	await expect(
		setupLsp(
			fixture.ctx,
			fixture.agentDir,
			fixture.project,
			"setup",
			fixture.ports,
			new AbortController().signal,
		),
	).rejects.toThrow("Trust this project");
});

it("uses selected languages with automatic executable, root, and route name", async () => {
	const fixture = await setupFixture([true]);
	await writeFile(join(fixture.project.root, "app.py"), "pass\n");
	const preset = presetById("pyright");
	const directory = managedToolDirectory(fixture.agentDir, preset);
	const executable = managedExecutable(directory, preset);
	await mkdir(join(directory, "node_modules/.bin"), { recursive: true });
	await writeFile(executable, "#!/bin/sh\nexit 0\n");
	await chmod(executable, 0o700);
	await writeFile(
		join(directory, "installation.json"),
		JSON.stringify({ preset: preset.id, version: preset.version }),
	);
	fixture.ports.selectLanguages = vi.fn(async () => ({
		action: "continue" as const,
		selected: ["typescript", "pyright"],
	}));
	fixture.ctx.ui.input = vi.fn();
	fixture.ctx.ui.select = vi.fn();
	const result = await setupLsp(
		fixture.ctx,
		fixture.agentDir,
		fixture.project,
		"setup",
		fixture.ports,
		new AbortController().signal,
	);
	expect(result?.profile.routes.map(({ id, root }) => ({ id, root }))).toEqual([
		{ id: "typescript", root: "." },
		{ id: "pyright", root: "." },
	]);
	expect(result?.profile.routes[1]?.command).toBe(executable);
	expect(fixture.ctx.ui.input).not.toHaveBeenCalled();
	expect(fixture.ctx.ui.select).not.toHaveBeenCalled();
	expect(fixture.confirm).toHaveBeenCalledTimes(1);
	expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
});

it("shares a receipt-verified installation across independently approved project profiles", async () => {
	const fixture = await setupFixture([true, true]);
	const preset = { ...presetById("pyright"), prerequisites: [] };
	const plan = installationPlan(fixture.agentDir, preset);
	const run = vi.fn(async () => {
		const executable = managedExecutable(plan.staging, preset);
		await mkdir(dirname(executable), { recursive: true });
		await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	});
	await installations.installLsp(
		plan,
		{ approve: async () => true, progress: vi.fn(), run },
		new AbortController().signal,
	);
	const receiptPath = join(plan.destination, "installation.json");
	const receipt = await readFile(receiptPath, "utf8");
	const install = vi.spyOn(installations, "installLsp");
	fixture.ports.selectLanguages = vi.fn(async () => ({ action: "continue" as const, selected: [preset.id] }));
	const secondRoot = join(dirname(fixture.project.root), "second-project");
	await mkdir(secondRoot);
	const secondProject = await resolveLspProject(secondRoot, fixture.agentDir);

	for (const project of [fixture.project, secondProject]) {
		await writeFile(join(project.root, "app.py"), "pass\n");
		const result = await setupLsp(
			{ ...fixture.ctx, cwd: project.root },
			fixture.agentDir,
			project,
			"setup",
			fixture.ports,
			new AbortController().signal,
		);
		expect(result?.profile).toMatchObject({
			projectId: project.id,
			enabled: true,
			routes: [{ command: managedExecutable(plan.destination, preset), version: preset.version }],
		});
		expect(fixture.ports.validate).toHaveBeenCalledWith(
			expect.objectContaining({ command: managedExecutable(plan.destination, preset) }),
			project,
			expect.any(AbortSignal),
		);
		expect((await loadLspProfile(fixture.agentDir, project))?.revision).toBe(result?.revision);
	}
	expect(secondProject.id).not.toBe(fixture.project.id);
	expect(fixture.confirm).toHaveBeenCalledTimes(2);
	expect(fixture.confirm).toHaveBeenNthCalledWith(
		1,
		"Validate and enable LSP checking?",
		expect.any(String),
		expect.any(Object),
	);
	expect(fixture.confirm).toHaveBeenNthCalledWith(
		2,
		"Validate and enable LSP checking?",
		expect.any(String),
		expect.any(Object),
	);
	expect(install).not.toHaveBeenCalled();
	expect(run).toHaveBeenCalledTimes(1);
	expect(await readFile(receiptPath, "utf8")).toBe(receipt);
});

it.each([
	{ presetId: "roslyn", layout: "tool-root" as const },
	{ presetId: "roslyn", layout: "managed" as const },
	{ presetId: "pyright", layout: "managed" as const },
])(
	"reuses an unreceipted $presetId executable in the $layout layout as external",
	async ({ presetId, layout }) => {
		const fixture = await unreceiptedServerFixture(presetId, layout);
		const install = vi.spyOn(installations, "installLsp");
		fixture.ports.selectLanguages = vi.fn(async () => ({
			action: "continue" as const,
			selected: [presetId],
		}));
		const result = await setupLsp(
			fixture.ctx,
			fixture.agentDir,
			fixture.project,
			"setup",
			fixture.ports,
			new AbortController().signal,
		);
		expect(result?.profile.routes).toEqual([
			expect.objectContaining({
				command: fixture.executable,
				version: `external; preset tested with ${fixture.preset.version}`,
			}),
		]);
		expect(fixture.ports.validate).toHaveBeenCalledWith(
			expect.objectContaining({ command: fixture.executable }),
			fixture.project,
			expect.any(AbortSignal),
		);
		expect(fixture.confirm).toHaveBeenCalledExactlyOnceWith(
			"Validate and enable LSP checking?",
			expect.stringContaining(fixture.executable),
			expect.any(Object),
		);
		expect(install).not.toHaveBeenCalled();
		await expect(lstat(join(fixture.directory, "installation.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	},
);

it("offers an unreceipted Roslyn tool-root executable in advanced setup", async () => {
	const fixture = await unreceiptedServerFixture("roslyn", "tool-root");
	const install = vi.spyOn(installations, "installLsp");
	fixture.ports.selectLanguages = vi.fn(async () => ({ action: "advanced" as const, selected: [] }));
	fixture.ctx.ui.select = vi
		.fn()
		.mockResolvedValueOnce("Add a server with custom options")
		.mockResolvedValueOnce(`${fixture.preset.label} (detected)`)
		.mockResolvedValueOnce(`Use ${fixture.executable}`)
		.mockResolvedValueOnce("App.csproj");
	fixture.ctx.ui.input = vi.fn().mockResolvedValue(".");
	const result = await setupLsp(
		fixture.ctx,
		fixture.agentDir,
		fixture.project,
		"setup",
		fixture.ports,
		new AbortController().signal,
	);
	expect(fixture.ctx.ui.select).toHaveBeenNthCalledWith(
		3,
		expect.any(String),
		expect.arrayContaining([`Use ${fixture.executable}`]),
		expect.any(Object),
	);
	expect(result?.profile.routes).toHaveLength(1);
	expect(result?.profile.routes[0]).toMatchObject({
		command: fixture.executable,
		version: `external; preset tested with ${fixture.preset.version}`,
		project: "App.csproj",
	});
	expect(fixture.confirm).toHaveBeenCalledTimes(1);
	expect(install).not.toHaveBeenCalled();
});

it("offers a private installation only when a selected server is missing", async () => {
	const fixture = await setupFixture([true, true]);
	await writeFile(join(fixture.project.root, "app.py"), "pass\n");
	fixture.ports.selectLanguages = vi.fn(async () => ({ action: "continue" as const, selected: ["pyright"] }));
	vi.spyOn(installations, "installedManagedExecutable").mockResolvedValue(undefined);
	vi.spyOn(presets, "findExecutable").mockResolvedValue(undefined);
	const install = vi.spyOn(installations, "installLsp").mockImplementation(async (_plan, ports) => {
		expect(await ports.approve("Install pinned Pyright privately")).toBe(true);
		return "/private/tools/pyright-langserver";
	});
	const result = await setupLsp(
		fixture.ctx,
		fixture.agentDir,
		fixture.project,
		"setup",
		fixture.ports,
		new AbortController().signal,
	);
	expect(install).toHaveBeenCalledTimes(1);
	expect(result?.profile.routes[0]).toMatchObject({
		id: "pyright",
		root: ".",
		command: "/private/tools/pyright-langserver",
		version: "1.1.414",
	});
	expect(fixture.confirm).toHaveBeenNthCalledWith(
		1,
		"Install missing language server?",
		"Install pinned Pyright privately",
		expect.any(Object),
	);
	expect(fixture.confirm).toHaveBeenNthCalledWith(
		2,
		"Validate and enable LSP checking?",
		expect.any(String),
		expect.any(Object),
	);
});

it("does not activate a draft changed during validation", async () => {
	const fixture = await setupFixture([true]);
	fixture.ports.validate = vi.fn(async () => {
		await saveLspDraft(fixture.agentDir, fixture.project, {
			version: 1,
			projectId: fixture.project.id,
			enabled: false,
			routes: [],
		});
		return { ready: true, summary: "Operational" };
	});
	await expect(
		approveLspSetup(
			fixture.ctx,
			fixture.agentDir,
			fixture.project,
			fixture.ports,
			new AbortController().signal,
		),
	).rejects.toThrow("draft changed during approval");
	expect(await loadLspProfile(fixture.agentDir, fixture.project)).toBeUndefined();
	expect(fixture.confirm).toHaveBeenCalledTimes(1);
});

it("leaves selection on existing languages instead of automatically enabling newly detected ones", async () => {
	const fixture = await setupFixture([]);
	await writeFile(join(fixture.project.root, "app.py"), "pass\n");
	await setupLsp(
		fixture.ctx,
		fixture.agentDir,
		fixture.project,
		"setup",
		fixture.ports,
		new AbortController().signal,
	);
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
		expect.any(AbortSignal),
	);
});

it("preserves edited overrides and removes only deselected languages", async () => {
	const fixture = await setupFixture([true]);
	fixture.route.diagnosticTimeoutMs = 25000;
	fixture.route.env = { CUSTOM_TOOL_PATH: "/tools" };
	await saveLspDraft(fixture.agentDir, fixture.project, {
		version: 1,
		projectId: fixture.project.id,
		enabled: true,
		routes: [fixture.route, presetRoute(presetById("pyright"), process.execPath)],
	});
	fixture.ports.selectLanguages = vi.fn(async () => ({
		action: "continue" as const,
		selected: ["typescript"],
	}));
	const result = await setupLsp(
		fixture.ctx,
		fixture.agentDir,
		fixture.project,
		"setup",
		fixture.ports,
		new AbortController().signal,
	);
	expect(result?.profile.routes).toEqual([fixture.route]);
});

it("disables LSP without running servers when all languages are deselected", async () => {
	const fixture = await setupFixture([true]);
	fixture.ports.selectLanguages = vi.fn(async () => ({ action: "continue" as const, selected: [] }));
	const result = await setupLsp(
		fixture.ctx,
		fixture.agentDir,
		fixture.project,
		"setup",
		fixture.ports,
		new AbortController().signal,
	);
	expect(result?.profile).toMatchObject({ enabled: false, routes: [] });
	expect(fixture.ports.validate).not.toHaveBeenCalled();
	expect(fixture.confirm).toHaveBeenCalledTimes(1);
});

it("offers configuration-file editing only through Advanced without validation", async () => {
	const fixture = await setupFixture([]);
	fixture.ports.selectLanguages = vi.fn(async () => ({
		action: "advanced" as const,
		selected: ["typescript"],
	}));
	fixture.ctx.ui.select = vi.fn().mockResolvedValue("Edit configuration file");
	await setupLsp(
		fixture.ctx,
		fixture.agentDir,
		fixture.project,
		"setup",
		fixture.ports,
		new AbortController().signal,
	);
	expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("setup approve"), "info");
	expect(fixture.ports.validate).not.toHaveBeenCalled();
});

it("infers roots and names without discarding C# projects of unknown membership", async () => {
	expect(
		suggestedWorkspaceRoots(presetById("typescript"), ["package.json", "packages/ui/tsconfig.json"]),
	).toEqual(["."]);
	expect(suggestedWorkspaceRoots(presetById("pyright"), ["backend/pyproject.toml"])).toEqual(["backend"]);
	expect(suggestedWorkspaceRoots(presetById("gopls"), ["api/go.mod", "tools/go.mod"])).toEqual([
		"api",
		"tools",
	]);
	expect(nextRouteId("pyright", "backend", new Set(["pyright-backend"]))).toBe("pyright-backend-2");
	const fixture = await setupFixture([]);
	fixture.ctx.ui.select = vi
		.fn()
		.mockResolvedValueOnce("tests/Test.csproj")
		.mockResolvedValueOnce("Tools.sln");
	const signal = new AbortController().signal;
	expect(
		await chooseCsharpProject(
			fixture.ctx,
			fixture.project,
			".",
			["App.sln", "src/App.csproj", "tests/Test.csproj"],
			signal,
		),
	).toBe("tests/Test.csproj");
	expect(fixture.ctx.ui.select).toHaveBeenCalledWith(
		"Which C# solution/project should Roslyn load?",
		["App.sln", "src/App.csproj", "tests/Test.csproj", "Enter a relative path"],
		{ signal },
	);
	expect(
		await chooseCsharpProject(
			fixture.ctx,
			fixture.project,
			".",
			["App.sln", "Tools.sln", "src/App.csproj"],
			signal,
		),
	).toBe("Tools.sln");
	expect(fixture.ctx.ui.select).toHaveBeenCalledTimes(2);
});

it("keeps a manual C# path override even with a single discovered solution", async () => {
	const fixture = await setupFixture([]);
	fixture.ctx.ui.select = vi.fn().mockResolvedValue("Enter a relative path");
	fixture.ctx.ui.input = vi.fn().mockResolvedValue("tools/Standalone.csproj");
	expect(
		await chooseCsharpProject(
			fixture.ctx,
			fixture.project,
			"src",
			["src/App.sln"],
			new AbortController().signal,
		),
	).toBe("tools/Standalone.csproj");
	expect(fixture.ctx.ui.select).toHaveBeenCalledWith(
		expect.any(String),
		["src/App.sln", "Enter a relative path"],
		expect.any(Object),
	);
});

it("prunes nested roots with thousands of sibling modules in deterministic order", () => {
	const roots = Array.from({ length: 2000 }, (_, index) => `modules/module-${index}`).sort();
	const files = roots.flatMap((root) => [`${root}/go.mod`, `${root}/nested/go.mod`]).reverse();
	expect(suggestedWorkspaceRoots(presetById("gopls"), files)).toEqual(roots);
	expect(suggestedWorkspaceRoots(presetById("gopls"), [...files, "go.work"])).toEqual(["."]);
});

it.each([true, false])(
	"discloses edited pending overrides before normal setup validation (consent: %s)",
	async (consent) => {
		const fixture = await setupFixture([true, consent]);
		const signal = new AbortController().signal;
		const active = await approveLspSetup(
			fixture.ctx,
			fixture.agentDir,
			fixture.project,
			fixture.ports,
			signal,
		);
		fixture.route.env = { NODE_OPTIONS: "--require /private/startup.js" };
		fixture.route.settings = { pluginPath: "/private/plugin.js" };
		fixture.route.initializationOptions = { analyzer: "/private/analyzer.js" };
		await saveLspDraft(fixture.agentDir, fixture.project, { ...active!.profile, routes: [fixture.route] });
		vi.mocked(fixture.ports.validate).mockClear();
		fixture.confirm.mockClear();
		fixture.ports.selectLanguages = vi.fn(async () => ({
			action: "continue" as const,
			selected: ["typescript"],
		}));
		fixture.ports.validate = vi.fn(async () => {
			expect(fixture.confirm).toHaveBeenCalledExactlyOnceWith(
				"Validate and enable LSP checking?",
				expect.stringContaining("Environment keys: NODE_OPTIONS"),
				expect.any(Object),
			);
			return { ready: true, summary: "Operational" };
		});
		await setupLsp(fixture.ctx, fixture.agentDir, fixture.project, "setup", fixture.ports, signal);
		const summary = vi.mocked(fixture.ctx.ui.confirm).mock.calls[0]![1];
		expect(summary).toContain('Settings: {"pluginPath":"/private/plugin.js"}');
		expect(summary).toContain('Initialization: {"analyzer":"/private/analyzer.js"}');
		expect(fixture.ports.validate).toHaveBeenCalledTimes(consent ? 1 : 0);
		if (!consent) expect(await loadLspProfile(fixture.agentDir, fixture.project)).toEqual(active);
	},
);

it.each([
	{
		action: "Add a server with custom options",
		expectedPresets: ["gopls", "custom", "pyright"],
		editsConfiguration: false,
	},
	{ action: "Edit configuration file", expectedPresets: ["gopls", "pyright"], editsConfiguration: true },
])(
	"carries selected additions, removals, and retained overrides into Advanced: $action",
	async ({ action, expectedPresets, editsConfiguration }) => {
		const fixture = await setupFixture([true]);
		const retained = presetRoute(presetById("gopls"), process.execPath);
		retained.env = { GOPROXY: "off" };
		await saveLspDraft(fixture.agentDir, fixture.project, {
			version: 1,
			projectId: fixture.project.id,
			enabled: true,
			routes: [fixture.route, retained],
		});
		fixture.ports.selectLanguages = vi.fn(async () => ({
			action: "advanced" as const,
			selected: ["gopls", "pyright"],
		}));
		vi.spyOn(installations, "installedManagedExecutable").mockResolvedValue(process.execPath);
		fixture.ctx.ui.select = vi
			.fn()
			.mockResolvedValueOnce(action)
			.mockResolvedValueOnce("Custom stdio server");
		fixture.ctx.ui.input = vi
			.fn()
			.mockResolvedValueOnce(".")
			.mockResolvedValueOnce(process.execPath)
			.mockResolvedValueOnce("[]")
			.mockResolvedValueOnce('{".ts":"typescript"}');
		const result = await setupLsp(
			fixture.ctx,
			fixture.agentDir,
			fixture.project,
			"setup",
			fixture.ports,
			new AbortController().signal,
		);
		const draft = await loadLspDraft(fixture.agentDir, fixture.project);
		const routes = draft!.draft.profile.routes;
		expect(routes.map((route) => route.preset)).toEqual(expectedPresets);
		expect(routes[0]).toEqual(retained);
		if (editsConfiguration) {
			expect(result).toBeUndefined();
			expect(await loadLspProfile(fixture.agentDir, fixture.project)).toBeUndefined();
			expect(fixture.ports.validate).not.toHaveBeenCalled();
		} else {
			expect(result?.profile.routes).toEqual(routes);
			expect(vi.mocked(fixture.ports.validate).mock.calls.map(([route]) => route)).toEqual(routes);
		}
	},
);

it("does not publish reconciled selections when Advanced is cancelled", async () => {
	const fixture = await setupFixture([]);
	const initial = await loadLspDraft(fixture.agentDir, fixture.project);
	fixture.ports.selectLanguages = vi.fn(async () => ({ action: "advanced" as const, selected: [] }));
	fixture.ctx.ui.select = vi
		.fn()
		.mockResolvedValueOnce("Add a server with custom options")
		.mockResolvedValueOnce("Cancel");
	await setupLsp(
		fixture.ctx,
		fixture.agentDir,
		fixture.project,
		"setup",
		fixture.ports,
		new AbortController().signal,
	);
	expect(await loadLspDraft(fixture.agentDir, fixture.project)).toEqual(initial);
	expect(fixture.ports.validate).not.toHaveBeenCalled();
});

it("discovers source and project files without descending into dependency/build directories", async () => {
	const fixture = await setupFixture([]);
	for (const directory of ["src", "node_modules", "obj", "target"])
		await mkdir(join(fixture.project.root, directory));
	await writeFile(join(fixture.project.root, "src/index.ts"), "");
	await writeFile(join(fixture.project.root, "App.csproj"), "");
	await writeFile(join(fixture.project.root, "node_modules/dependency.py"), "");
	await writeFile(join(fixture.project.root, "obj/generated.cs"), "");
	expect(await discoverLspFiles(fixture.project.root, new AbortController().signal)).toEqual({
		files: ["App.csproj", "src/index.ts"],
		truncated: false,
	});
});

it.each(["typescript", "pyright", "roslyn", "gopls", "rust-analyzer"])(
	"plans a private pinned %s install without SDK installation commands",
	(id) => {
		const plan = installationPlan("/private/pi", presetById(id));
		expect(plan.destination).toContain(`/extensions/code-quality/tools/${id}/`);
		expect(plan.staging).toContain(`${plan.destination}.staging-`);
		expect(plan.commands.length).toBeGreaterThan(0);
		expect(installationSummary(plan)).toContain(plan.preset.version);
		expect(plan.commands.some((step) => ["sudo", "brew", "rustup"].includes(step.command))).toBe(false);
	},
);
