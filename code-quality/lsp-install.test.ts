import { chmod, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

it("reuses a receipt-verified installation without approval, prerequisites, or install commands", async () => {
	const fixture = await installFixture();
	const executable = await installLsp(fixture.plan, fixture.ports, new AbortController().signal);
	const receiptPath = join(fixture.plan.destination, "installation.json");
	const receipt = await readFile(receiptPath, "utf8");
	const repeatPlan = installationPlan(fixture.agentDir, {
		...fixture.preset,
		prerequisites: ["missing-lsp-install-prerequisite"],
	});
	const repeatPorts: InstallPorts = {
		approve: vi.fn(async () => false),
		progress: vi.fn(),
		run: vi.fn(),
	};

	expect(await installLsp(repeatPlan, repeatPorts, new AbortController().signal)).toBe(executable);
	expect(repeatPorts.approve).not.toHaveBeenCalled();
	expect(repeatPorts.run).not.toHaveBeenCalled();
	expect(await readFile(receiptPath, "utf8")).toBe(receipt);
	await expect(lstat(repeatPlan.staging)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(lstat(`${repeatPlan.destination}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reuses an installation completed while another setup was awaiting approval", async () => {
	const fixture = await installFixture();
	const waitingPlan = installationPlan(fixture.agentDir, fixture.preset);
	const waitingPorts: InstallPorts = {
		approve: vi.fn(async () => {
			await installLsp(fixture.plan, fixture.ports, new AbortController().signal);
			return true;
		}),
		progress: vi.fn(),
		run: vi.fn(),
	};

	expect(await installLsp(waitingPlan, waitingPorts, new AbortController().signal)).toBe(
		managedExecutable(fixture.plan.destination, fixture.preset),
	);
	expect(waitingPorts.approve).toHaveBeenCalledTimes(1);
	expect(waitingPorts.run).not.toHaveBeenCalled();
	expect(fixture.run).toHaveBeenCalledTimes(1);
	await expect(lstat(`${waitingPlan.destination}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
	{ scenario: "missing receipt", receipt: undefined, hasExecutable: true },
	{ scenario: "wrong version", receipt: { preset: "typescript", version: "0.0.0" }, hasExecutable: true },
	{ scenario: "wrong preset", receipt: { preset: "pyright", version: "6.0.1" }, hasExecutable: true },
	{
		scenario: "missing executable",
		receipt: { preset: "typescript", version: "6.0.1" },
		hasExecutable: false,
	},
])("preserves an unverified destination with $scenario", async ({ receipt, hasExecutable }) => {
	const fixture = await installFixture();
	const executable = managedExecutable(fixture.plan.destination, fixture.preset);
	await mkdir(dirname(executable), { recursive: true });
	if (hasExecutable) {
		await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	}
	const receiptPath = join(fixture.plan.destination, "installation.json");
	if (receipt) {
		await writeFile(receiptPath, JSON.stringify(receipt));
	}

	expect(await installedManagedExecutable(fixture.agentDir, fixture.preset)).toBeUndefined();
	await expect(installLsp(fixture.plan, fixture.ports, new AbortController().signal)).rejects.toThrow(
		`no receipt-verified executable: ${fixture.plan.destination}`,
	);
	expect(fixture.run).not.toHaveBeenCalled();
	expect((await lstat(fixture.plan.destination)).isDirectory()).toBe(true);
	if (hasExecutable) {
		expect(await readFile(executable, "utf8")).toBe("#!/bin/sh\nexit 0\n");
	}
	if (receipt) {
		expect(await readFile(receiptPath, "utf8")).toBe(JSON.stringify(receipt));
	} else {
		await expect(lstat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
	}
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
