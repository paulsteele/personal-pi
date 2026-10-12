import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { handleLspCommand, type LspCommandPorts } from "./lsp-commands.js";
import { resolveLspProject } from "./lsp-profile.js";
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
		ui: { notify: vi.fn() },
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
	return { ctx, agentDir, project, ports, signal: new AbortController().signal };
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
