import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	findExecutable,
	managedExecutable,
	managedToolDirectory,
	type LspPresetDefinition,
} from "./lsp-presets.js";

export interface InstallCommand {
	command: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
}
export interface LspInstallation {
	preset: LspPresetDefinition;
	destination: string;
	staging: string;
	commands: InstallCommand[];
	archive?: { url: string; filename: string; extractedDirectory: string };
}
export interface InstallPorts {
	approve(summary: string): Promise<boolean>;
	progress(text: string): void;
	run?: typeof runInstallCommand;
}

export async function runInstallCommand(
	step: InstallCommand,
	signal: AbortSignal,
	progress: (text: string) => void,
): Promise<void> {
	signal.throwIfAborted();
	const child = spawn(step.command, step.args, {
		cwd: step.cwd,
		env: { ...process.env, ...step.env },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	let tail = "";
	const output = (chunk: Buffer) => {
		tail = (tail + chunk.toString("utf8")).slice(-8000);
		progress(tail);
	};
	child.stdout.on("data", output);
	child.stderr.on("data", output);
	const kill = () => {
		if (!child.pid) return;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
		}
	};
	signal.addEventListener("abort", kill, { once: true });
	if (signal.aborted) kill();
	try {
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) =>
				code === 0 ? resolve() : reject(new Error(`Installation command failed (${code}): ${tail}`)),
			);
		});
		signal.throwIfAborted();
	} finally {
		signal.removeEventListener("abort", kill);
	}
}

export function installationPlan(agentDir: string, preset: LspPresetDefinition): LspInstallation {
	const destination = managedToolDirectory(agentDir, preset);
	const staging = `${destination}.staging-${randomUUID()}`;
	const commands: InstallCommand[] = [];
	let archive: LspInstallation["archive"];
	switch (preset.installation) {
		case "npm":
			commands.push({
				command: "npm",
				args: [
					"install",
					"--prefix",
					staging,
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					...preset.packages,
				],
			});
			break;
		case "dotnet":
			commands.push({
				command: "dotnet",
				args: [
					"tool",
					"install",
					preset.executable,
					"--version",
					preset.version,
					"--tool-path",
					join(staging, "bin"),
				],
			});
			break;
		case "go":
			commands.push({
				command: "go",
				args: ["install", ...preset.packages],
				cwd: staging,
				env: { GOBIN: join(staging, "bin"), GOTOOLCHAIN: "local" },
			});
			break;
		case "rust-component": {
			const architecture =
				process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
			const platform =
				process.platform === "darwin"
					? "apple-darwin"
					: process.platform === "linux"
						? "unknown-linux-gnu"
						: undefined;
			if (!architecture || !platform) throw new Error("No managed rust-analyzer package for this platform");
			const extractedDirectory = `rust-analyzer-${preset.version}-${architecture}-${platform}`;
			const filename = `${extractedDirectory}.tar.xz`;
			archive = { url: `https://static.rust-lang.org/dist/${filename}`, filename, extractedDirectory };
			commands.push(
				{ command: "tar", args: ["-xJf", join(staging, filename), "-C", staging] },
				{
					command: join(staging, extractedDirectory, "install.sh"),
					args: [`--prefix=${staging}`, "--disable-ldconfig"],
				},
			);
			break;
		}
	}
	return { preset, destination, staging, commands, ...(archive ? { archive } : {}) };
}

export function installationSummary(plan: LspInstallation): string {
	return [
		`${plan.preset.label} ${plan.preset.version}`,
		`Destination: ${plan.destination}`,
		plan.preset.installationNotice,
		...(plan.archive
			? [`Download ${plan.archive.url} and verify its official SHA-256 sidecar before extraction.`]
			: []),
		...plan.commands.map(
			(step) =>
				`${JSON.stringify(step.env ?? {})} ${[step.command, ...step.args].map((value) => JSON.stringify(value)).join(" ")}`,
		),
		"Install and validate this executable? No SDK, project dependency, or shell PATH changes will be made.",
	].join("\n\n");
}

async function downloadArchive(plan: LspInstallation, signal: AbortSignal): Promise<void> {
	if (!plan.archive) return;
	const checksumResponse = await fetch(`${plan.archive.url}.sha256`, { signal });
	if (!checksumResponse.ok) throw new Error("Cannot download official archive checksum");
	const checksum = (await checksumResponse.text()).trim().split(/\s+/)[0];
	if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error("Invalid official archive checksum");
	const response = await fetch(plan.archive.url, { signal });
	if (!response.ok || !response.body) throw new Error("Cannot download language server archive");
	const file = await open(join(plan.staging, plan.archive.filename), "wx", 0o600);
	const hash = createHash("sha256");
	let bytes = 0;
	try {
		for await (const chunk of response.body) {
			signal.throwIfAborted();
			bytes += chunk.byteLength;
			if (bytes > 256 * 1024 * 1024) throw new Error("Language server archive exceeds 256 MiB");
			hash.update(chunk);
			await file.writeFile(chunk);
		}
	} finally {
		await file.close();
	}
	if (hash.digest("hex") !== checksum) throw new Error("Language server archive checksum mismatch");
}

async function assertPrivateInstallPath(path: string): Promise<void> {
	for (let current = path; ; current = dirname(current)) {
		try {
			if ((await lstat(current)).isSymbolicLink())
				throw new Error(`Refusing symlink installation path: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (dirname(current) === current) return;
	}
}

export async function installLsp(
	plan: LspInstallation,
	ports: InstallPorts,
	signal: AbortSignal,
): Promise<string> {
	await assertPrivateInstallPath(plan.destination);
	await assertPrivateInstallPath(plan.staging);
	signal.throwIfAborted();
	const installed = await receiptVerifiedExecutable(plan.destination, plan.preset);
	if (installed) {
		return installed;
	}
	for (const tool of plan.preset.prerequisites) {
		if (!(await findExecutable(tool, process.cwd())))
			throw new Error(`Missing prerequisite ${tool}; install the SDK yourself or select an existing server`);
	}
	if (!(await ports.approve(installationSummary(plan))))
		throw new Error("Language server installation cancelled");
	signal.throwIfAborted();
	await mkdir(dirname(plan.destination), { recursive: true, mode: 0o700 });
	const lockPath = `${plan.destination}.lock`;
	const lock = await open(lockPath, "wx", 0o600).catch(() => {
		throw new Error("This language server is already being installed; retry when it finishes");
	});
	try {
		await lock.writeFile(JSON.stringify({ pid: process.pid }));
		const installedWhileApproving = await receiptVerifiedExecutable(plan.destination, plan.preset);
		if (installedWhileApproving) {
			return installedWhileApproving;
		}
		try {
			await lstat(plan.destination);
			throw new Error(
				`Managed language server directory exists but has no receipt-verified executable: ${plan.destination}. Run /quality lsp setup to select an existing executable, or inspect the incomplete installation. Nothing was overwritten.`,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await mkdir(plan.staging, { recursive: true, mode: 0o700 });
		const installationSignal = AbortSignal.any([signal, AbortSignal.timeout(300000)]);
		await downloadArchive(plan, installationSignal);
		for (const step of plan.commands)
			await (ports.run ?? runInstallCommand)(step, installationSignal, ports.progress);
		if (!(await findExecutable(managedExecutable(plan.staging, plan.preset), plan.staging)))
			throw new Error("Installation did not produce the expected executable");
		const receipt = await open(join(plan.staging, "installation.json"), "wx", 0o600);
		try {
			await receipt.writeFile(JSON.stringify({ preset: plan.preset.id, version: plan.preset.version }));
		} finally {
			await receipt.close();
		}
		signal.throwIfAborted();
		await rename(plan.staging, plan.destination);
		return managedExecutable(plan.destination, plan.preset);
	} finally {
		await lock.close();
		await rm(plan.staging, { recursive: true, force: true });
		await rm(lockPath, { force: true });
	}
}

export async function installedManagedExecutable(
	agentDir: string,
	preset: LspPresetDefinition,
): Promise<string | undefined> {
	return receiptVerifiedExecutable(managedToolDirectory(agentDir, preset), preset);
}

async function receiptVerifiedExecutable(
	directory: string,
	preset: LspPresetDefinition,
): Promise<string | undefined> {
	try {
		const receipt = JSON.parse(await readFile(join(directory, "installation.json"), "utf8"));
		if (receipt.preset !== preset.id || receipt.version !== preset.version) {
			return undefined;
		}
		return await findExecutable(managedExecutable(directory, preset), directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}
