import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { approveLspSetup, discoverLspFiles, setupLsp, type LspSetupPorts } from "./lsp-setup.js";
import { loadLspDraft, loadLspProfile, resolveLspProject, saveLspDraft } from "./lsp-profile.js";
import { presetById, presetRoute } from "./lsp-presets.js";
import { installationPlan, installationSummary } from "./lsp-install.js";

const directories: string[] = [];
afterEach(async () => {
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
		mode: "tui",
		isProjectTrusted: () => true,
		ui: { confirm, notify: vi.fn() },
	} as unknown as ExtensionContext;
	const ports: LspSetupPorts = {
		validate: vi.fn(async () => ({ ready: true, summary: "1 existing warning" })),
		progress: vi.fn(),
	};
	return { ctx, ports, agentDir, project, route, confirm };
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
	expect(fixture.confirm).toHaveBeenCalledTimes(2);
	expect(result?.profile.routes).toEqual([fixture.route]);
	expect((await loadLspProfile(fixture.agentDir, fixture.project))?.revision).toBe(result?.revision);
});

it("keeps a validated draft inactive when final approval is declined", async () => {
	const fixture = await setupFixture([true, false]);
	expect(
		await approveLspSetup(
			fixture.ctx,
			fixture.agentDir,
			fixture.project,
			fixture.ports,
			new AbortController().signal,
		),
	).toBeUndefined();
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
