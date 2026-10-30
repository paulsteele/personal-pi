import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { handleLspCommand, type LspCommandPorts } from "./lsp-commands.js";
import {
	approveLspDraft,
	loadLspDraft,
	loadLspProfile,
	resolveLspProject,
	saveLspDraft,
} from "./lsp-profile.js";
import { presetById, presetRoute } from "./lsp-presets.js";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function commandFixture(enabled = true) {
	const directory = await mkdtemp(join(tmpdir(), "lsp-command-"));
	directories.push(directory);
	const cwd = join(directory, "project");
	await mkdir(cwd);
	const agentDir = join(directory, "agent");
	const project = await resolveLspProject(cwd, agentDir);
	const approved = {
		profile: {
			version: 1 as const,
			projectId: project.id,
			enabled,
			routes: enabled ? [presetRoute(presetById("pyright"), "/opt/pyright-langserver")] : [],
		},
		revision: "approved-revision",
	};
	const ctx = {
		cwd,
		mode: "tui",
		isProjectTrusted: () => true,
		ui: { notify: vi.fn(), confirm: vi.fn(async () => true) },
	} as unknown as ExtensionContext;
	let ready = false;
	const ports: LspCommandPorts = {
		setup: vi.fn(async () => approved),
		status: vi.fn(() => (ready ? "pyright: ready (Podman)" : "pyright: connecting (Podman)")),
		reload: vi.fn(async () => {
			ready = true;
		}),
		validate: vi.fn(),
		progress: vi.fn(),
		restart: vi.fn(),
		hasPendingCase: () => false,
		waivePendingLsp: vi.fn(),
	};
	return { ctx, agentDir, project, ports, profile: approved.profile, signal: new AbortController().signal };
}

async function draftCommandFixture(hasApprovedProfile = true) {
	const fixture = await commandFixture();
	const { agentDir, project, profile } = fixture;
	await saveLspDraft(agentDir, project, profile);
	const initialDraft = (await loadLspDraft(agentDir, project))!;
	const active = hasApprovedProfile
		? await approveLspDraft(agentDir, project, initialDraft.revision)
		: undefined;
	await saveLspDraft(
		agentDir,
		project,
		{
			...profile,
			routes: profile.routes.map((route) => ({
				...route,
				settings: { "python.analysis": { typeCheckingMode: "strict" } },
			})),
		},
		active?.revision ?? null,
		initialDraft.revision,
	);
	return { ...fixture, active, pending: (await loadLspDraft(agentDir, project))! };
}

it("reports setup completion only after the approved profile reload finishes", async () => {
	const fixture = await commandFixture();
	await handleLspCommand("setup", fixture.ctx, fixture.agentDir, fixture.ports, fixture.signal);
	expect(fixture.ports.reload).toHaveBeenCalledWith(fixture.signal);
	expect(fixture.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
		"LSP setup approved.\npyright: ready (Podman)",
		"info",
	);
});

it("does not report approval when setup is cancelled", async () => {
	const fixture = await commandFixture();
	vi.mocked(fixture.ports.setup!).mockResolvedValue(undefined);
	await handleLspCommand("setup", fixture.ctx, fixture.agentDir, fixture.ports, fixture.signal);
	expect(fixture.ports.reload).not.toHaveBeenCalled();
	expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
});

it("does not claim readiness when approved-profile startup fails", async () => {
	const fixture = await commandFixture();
	vi.mocked(fixture.ports.reload).mockRejectedValue(new Error("Container server failed to start"));
	await expect(
		handleLspCommand("setup approve", fixture.ctx, fixture.agentDir, fixture.ports, fixture.signal),
	).rejects.toThrow("Container server failed to start");
	expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
});

it("confirms completion of an approved disabled configuration", async () => {
	const fixture = await commandFixture(false);
	await handleLspCommand("setup", fixture.ctx, fixture.agentDir, fixture.ports, fixture.signal);
	expect(fixture.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
		"LSP setup approved; checking is disabled.",
		"info",
	);
});

it.each([true, false])(
	"discards a confirmed draft without changing the approved profile (existing profile: %s)",
	async (hasApprovedProfile) => {
		const fixture = await draftCommandFixture(hasApprovedProfile);
		fixture.ports.hasPendingCase = () => true;
		await handleLspCommand("setup discard", fixture.ctx, fixture.agentDir, fixture.ports, fixture.signal);
		expect(fixture.ctx.ui.confirm).toHaveBeenCalledExactlyOnceWith(
			"Discard LSP configuration draft?",
			"This deletes the shared project's draft, including unapproved edits. The approved profile and pending quality case remain unchanged.",
			{ signal: fixture.signal },
		);
		expect(await loadLspDraft(fixture.agentDir, fixture.project)).toBeUndefined();
		expect(await loadLspProfile(fixture.agentDir, fixture.project)).toEqual(fixture.active);
		expect(fixture.ports.waivePendingLsp).not.toHaveBeenCalled();
		expect(fixture.ports.reload).not.toHaveBeenCalled();
		expect(fixture.ports.setup).not.toHaveBeenCalled();
		expect(fixture.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
			"LSP draft discarded. The approved profile is unchanged.",
			"info",
		);
	},
);

it("retains the draft when discard confirmation is cancelled", async () => {
	const fixture = await draftCommandFixture();
	vi.mocked(fixture.ctx.ui.confirm).mockResolvedValue(false);
	await handleLspCommand("setup discard", fixture.ctx, fixture.agentDir, fixture.ports, fixture.signal);
	expect(await loadLspDraft(fixture.agentDir, fixture.project)).toEqual(fixture.pending);
	expect(await loadLspProfile(fixture.agentDir, fixture.project)).toEqual(fixture.active);
	expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
});

it("reports a missing draft without requesting confirmation", async () => {
	const fixture = await commandFixture();
	await handleLspCommand("setup discard", fixture.ctx, fixture.agentDir, fixture.ports, fixture.signal);
	expect(fixture.ctx.ui.confirm).not.toHaveBeenCalled();
	expect(fixture.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith("No LSP draft to discard.", "info");
	expect(fixture.ports.setup).not.toHaveBeenCalled();
});

it("retains a draft changed while discard confirmation is open", async () => {
	const fixture = await draftCommandFixture();
	const replacementProfile = { ...fixture.pending.draft.profile, enabled: false };
	vi.mocked(fixture.ctx.ui.confirm).mockImplementation(async () => {
		await saveLspDraft(
			fixture.agentDir,
			fixture.project,
			replacementProfile,
			fixture.pending.draft.baseRevision,
			fixture.pending.revision,
		);
		return true;
	});
	await expect(
		handleLspCommand("setup discard", fixture.ctx, fixture.agentDir, fixture.ports, fixture.signal),
	).rejects.toThrow("changed since preview");
	expect((await loadLspDraft(fixture.agentDir, fixture.project))?.draft.profile).toEqual(replacementProfile);
	expect(await loadLspProfile(fixture.agentDir, fixture.project)).toEqual(fixture.active);
	expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
});

it("retains the draft when the command is aborted during confirmation", async () => {
	const fixture = await draftCommandFixture();
	const controller = new AbortController();
	vi.mocked(fixture.ctx.ui.confirm).mockImplementation(async () => {
		controller.abort();
		return true;
	});
	await expect(
		handleLspCommand("setup discard", fixture.ctx, fixture.agentDir, fixture.ports, controller.signal),
	).rejects.toThrow();
	expect(await loadLspDraft(fixture.agentDir, fixture.project)).toEqual(fixture.pending);
	expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
});

it.each(["on", "off"])("shows both draft recovery commands before confirming LSP %s", async (action) => {
	const fixture = await draftCommandFixture();
	await expect(
		handleLspCommand(action, fixture.ctx, fixture.agentDir, fixture.ports, fixture.signal),
	).rejects.toThrow(
		"An edited LSP draft is pending. Run /quality lsp setup approve to validate and activate it, or /quality lsp setup discard to delete it before changing enabled state.",
	);
	expect(fixture.ctx.ui.confirm).not.toHaveBeenCalled();
	expect(await loadLspDraft(fixture.agentDir, fixture.project)).toEqual(fixture.pending);
});

it("allows LSP off after discarding unapproved edits and keeps the approved routes", async () => {
	const fixture = await draftCommandFixture();
	await handleLspCommand("setup discard", fixture.ctx, fixture.agentDir, fixture.ports, fixture.signal);
	await handleLspCommand("off", fixture.ctx, fixture.agentDir, fixture.ports, fixture.signal);
	expect((await loadLspProfile(fixture.agentDir, fixture.project))?.profile).toEqual({
		...fixture.active!.profile,
		enabled: false,
	});
	expect(fixture.ports.reload).toHaveBeenCalledExactlyOnceWith(fixture.signal);
});

it("lists discard in setup usage for an unknown subcommand", async () => {
	const fixture = await commandFixture();
	await expect(
		handleLspCommand("setup unknown", fixture.ctx, fixture.agentDir, fixture.ports, fixture.signal),
	).rejects.toThrow("Usage: /quality lsp setup [edit|approve|discard]");
	expect(fixture.ports.setup).not.toHaveBeenCalled();
});
