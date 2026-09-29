import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	installLsp,
	installationPlan,
	installedManagedExecutable,
	type InstallPorts,
} from "./lsp-install.js";
import { managedExecutable, presetById } from "./lsp-presets.js";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function installFixture() {
	const agentDir = await mkdtemp(join(tmpdir(), "lsp-install-"));
	directories.push(agentDir);
	const presetWithoutPrerequisites = { ...presetById("typescript"), prerequisites: [] };
	const plan = installationPlan(agentDir, presetWithoutPrerequisites);
	const createStagedExecutable = vi.fn(async () => {
		const executable = managedExecutable(plan.staging, presetWithoutPrerequisites);
		await mkdir(dirname(executable), { recursive: true });
		await writeFile(executable, "#!/bin/sh\nexit 0\n");
		await chmod(executable, 0o700);
	});
	const ports: InstallPorts = {
		approve: vi.fn(async () => true),
		progress: vi.fn(),
		run: createStagedExecutable,
	};
	return { agentDir, preset: presetWithoutPrerequisites, plan, ports, run: createStagedExecutable };
}

it("never executes or publishes an installation without approval", async () => {
	const fixture = await installFixture();
	fixture.ports.approve = async () => false;
	await expect(installLsp(fixture.plan, fixture.ports, new AbortController().signal)).rejects.toThrow(
		"cancelled",
	);
	expect(fixture.run).not.toHaveBeenCalled();
	expect(await installedManagedExecutable(fixture.agentDir, fixture.preset)).toBeUndefined();
});

it("publishes an executable only after the complete installation succeeds", async () => {
	const fixture = await installFixture();
	const executable = await installLsp(fixture.plan, fixture.ports, new AbortController().signal);
	expect(executable).toBe(managedExecutable(fixture.plan.destination, fixture.preset));
	expect(await installedManagedExecutable(fixture.agentDir, fixture.preset)).toBeTruthy();
	expect(fixture.run).toHaveBeenCalledTimes(1);
});

it("does not publish a partial installation when a command fails", async () => {
	const fixture = await installFixture();
	fixture.ports.run = async () => {
		await fixture.run();
		throw new Error("installation interrupted");
	};
	await expect(installLsp(fixture.plan, fixture.ports, new AbortController().signal)).rejects.toThrow(
		"interrupted",
	);
	expect(await installedManagedExecutable(fixture.agentDir, fixture.preset)).toBeUndefined();
});

it("serializes concurrent installers for the same destination", async () => {
	const fixture = await installFixture();
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	fixture.ports.run = async () => {
		entered();
		await blocked;
		await fixture.run();
	};
	const first = installLsp(fixture.plan, fixture.ports, new AbortController().signal);
	await started;
	try {
		await expect(
			installLsp(
				installationPlan(fixture.agentDir, fixture.preset),
				fixture.ports,
				new AbortController().signal,
			),
		).rejects.toThrow("already being installed");
	} finally {
		release();
		await first;
	}
	expect(fixture.run).toHaveBeenCalledTimes(1);
});
