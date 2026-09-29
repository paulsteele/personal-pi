import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { lspStorageRoot, type LspRoute } from "./lsp-profile.js";
import {
	LSP_BROKER_VERSION,
	type BrokerLaunch,
	type BrokerRegistry,
	type BrokerReply,
	type BrokerRequest,
} from "./lsp-broker-protocol.js";
import type { LspCheckResult, LspFileRequest, LspServerStatus } from "./lsp-diagnostics.js";

function sortedJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => `${JSON.stringify(key)}:${sortedJson(value)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export function serverEnvironment(route: LspRoute): Record<string, string> {
	const inheritedServerEnvironmentKeys = [
		"PATH",
		"HOME",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"DOTNET_ROOT",
		"DOTNET_ROOT_ARM64",
		"GOROOT",
		"GOPATH",
		"GOCACHE",
		"GOPROXY",
		"GOTOOLCHAIN",
		"RUSTUP_HOME",
		"RUSTUP_TOOLCHAIN",
		"CARGO_HOME",
		"CARGO_TARGET_DIR",
		"VIRTUAL_ENV",
		"PYTHONPATH",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
	];
	const inherited = Object.fromEntries(
		inheritedServerEnvironmentKeys
			.filter((key) => process.env[key] !== undefined)
			.map((key) => [key, process.env[key]!]),
	);
	return { ...inherited, ...route.env };
}

export function brokerKey(root: string, route: LspRoute): string {
	const configuration = {
		command: route.command,
		args: route.args,
		preset: route.preset,
		version: route.version,
		env: route.env,
		settings: route.settings,
		initializationOptions: route.initializationOptions,
		project: route.project,
		extensions: route.extensions,
	};
	const environment = serverEnvironment(route);
	return createHash("sha256")
		.update(sortedJson({ root, configuration, environment, version: LSP_BROKER_VERSION }))
		.digest("hex");
}

export class BrokerConnection {
	private sequence = 0;
	private readonly waiting = new Map<
		string,
		{ resolve(value: LspCheckResult | LspServerStatus): void; reject(error: Error): void }
	>();
	private attached = false;
	private disconnected = false;
	private closing?: Promise<void>;
	status?: LspServerStatus;
	private constructor(
		readonly registry: BrokerRegistry,
		private readonly socket: Socket,
		readonly clientId: string,
		private readonly update: (status: LspServerStatus, invalidated: boolean) => void,
	) {
		const lines = createInterface({ input: socket, crlfDelay: Infinity });
		lines.on("error", () => socket.destroy());
		let pendingBytes = 0;
		const maxPendingBytes = 2 * 1024 * 1024;
		socket.on("data", (chunk) => {
			pendingBytes += chunk.length;
			if (pendingBytes > maxPendingBytes) socket.destroy(new Error("Broker response exceeds limit"));
			const lastNewline = chunk.lastIndexOf(10);
			if (lastNewline >= 0) pendingBytes = chunk.length - lastNewline - 1;
		});
		lines.on("line", (line) => {
			if (Buffer.byteLength(line) > maxPendingBytes) {
				socket.destroy();
				return;
			}
			try {
				const reply = JSON.parse(line) as BrokerReply;
				if (reply.event && reply.status) {
					this.status = reply.status;
					update(reply.status, reply.event === "invalidated");
				}
				if (!reply.id) return;
				const pending = this.waiting.get(reply.id);
				if (!pending) return;
				this.waiting.delete(reply.id);
				if (reply.error) pending.reject(new Error(reply.error));
				else if (reply.result) pending.resolve(reply.result);
				else pending.reject(new Error("Malformed broker response"));
			} catch {
				socket.destroy();
			}
		});
		const fail = () => {
			this.disconnected = true;
			lines.close();
			for (const request of this.waiting.values())
				request.reject(new Error("Shared LSP broker disconnected"));
			this.waiting.clear();
			if (this.attached)
				update(
					{
						id: registry.route.id,
						name: registry.route.preset,
						root: registry.root,
						phase: "failed",
						clients: 0,
						reason: "Shared broker disconnected",
					},
					true,
				);
		};
		socket.once("close", fail);
		socket.on("error", () => {});
	}
	static async connect(
		registry: BrokerRegistry,
		clientId: string,
		update: (status: LspServerStatus, invalidated: boolean) => void,
	): Promise<BrokerConnection> {
		const socket = createConnection(registry.socket);
		const connection = new BrokerConnection(registry, socket, clientId, update);
		try {
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					socket.destroy();
					reject(new Error("Broker socket connection timed out"));
				}, 2000);
				socket.once("connect", () => {
					clearTimeout(timeout);
					resolve();
				});
				socket.once("error", (error) => {
					clearTimeout(timeout);
					reject(error);
				});
			});
			connection.status = (await connection.request(
				"attach",
				{},
				AbortSignal.timeout(5000),
			)) as LspServerStatus;
			connection.attached = true;
			return connection;
		} catch (error) {
			socket.destroy();
			throw error;
		}
	}
	private request(
		method: BrokerRequest["method"],
		input: Partial<BrokerRequest>,
		signal: AbortSignal,
	): Promise<LspCheckResult | LspServerStatus> {
		signal.throwIfAborted();
		if (this.disconnected) return Promise.reject(new Error("Broker connection is closed"));
		const id = String(++this.sequence);
		return new Promise((resolve, reject) => {
			const abort = () => {
				this.waiting.delete(id);
				this.socket.write(
					`${JSON.stringify({ id: `cancel-${id}`, token: this.registry.token, clientId: this.clientId, method: "cancel", requestId: id })}\n`,
				);
				reject(new Error("Broker request cancelled or timed out"));
			};
			this.waiting.set(id, {
				resolve: (result) => {
					signal.removeEventListener("abort", abort);
					resolve(result);
				},
				reject: (error) => {
					signal.removeEventListener("abort", abort);
					reject(error);
				},
			});
			signal.addEventListener("abort", abort, { once: true });
			this.socket.write(
				`${JSON.stringify({ ...input, id, token: this.registry.token, clientId: this.clientId, method })}\n`,
			);
		});
	}
	async check(files: LspFileRequest[], signal: AbortSignal): Promise<LspCheckResult> {
		return (await this.request("check", { files }, signal)) as LspCheckResult;
	}
	async restart(signal: AbortSignal): Promise<void> {
		await this.request("restart", {}, signal);
	}
	close(): Promise<void> {
		this.closing ??= this.detach();
		return this.closing;
	}
	private async detach(): Promise<void> {
		this.attached = false;
		try {
			if (!this.disconnected) await this.request("detach", {}, AbortSignal.timeout(10000));
		} finally {
			this.socket.destroy();
		}
	}
}

async function readRegistry(path: string): Promise<BrokerRegistry | undefined> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
			throw new Error("Unsafe broker registry");
		const registry = JSON.parse(await readFile(path, "utf8")) as BrokerRegistry;
		if (registry.version !== 1 || !registry.token || !Number.isSafeInteger(registry.pid))
			throw new Error("Invalid broker registry");
		return registry;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function recoverAbandonedStartup(lockPath: string): Promise<void> {
	let recoveryLock: Awaited<ReturnType<typeof open>>;
	try {
		recoveryLock = await open(`${lockPath}.recovery`, "wx", 0o600);
	} catch {
		return;
	}
	try {
		const owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
		if (Number.isSafeInteger(owner.pid) && owner.pid! > 0 && !processExists(owner.pid!))
			await unlink(lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new Error("Startup lock cannot be verified; inspect it before retrying", { cause: error });
	} finally {
		await recoveryLock.close();
		await unlink(`${lockPath}.recovery`).catch(() => {});
	}
}

async function awaitRetiredGuard(registry: BrokerRegistry, signal: AbortSignal): Promise<void> {
	const guardPath = join(registry.directory, "guard.json");
	let guard: { pid?: number };
	try {
		guard = JSON.parse(await readFile(guardPath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw new Error("Cannot verify the previous LSP guard; inspect runtime state", { cause: error });
	}
	const hasValidGuardPid = Number.isSafeInteger(guard.pid) && guard.pid! > 0;
	if (!hasValidGuardPid) throw new Error("Invalid previous LSP guard identity");
	const deadline = performance.now() + 5000;
	while (processExists(guard.pid!)) {
		signal.throwIfAborted();
		if (performance.now() >= deadline)
			throw new Error("Previous LSP guard is still retiring; retry after cleanup");
		await sleep(50);
	}
}

export async function attachBroker(
	agentDir: string,
	root: string,
	route: LspRoute,
	clientId: string,
	update: (status: LspServerStatus, invalidated: boolean) => void,
	signal: AbortSignal,
): Promise<BrokerConnection> {
	const key = brokerKey(root, route);
	const directory = join(lspStorageRoot(agentDir), "brokers", key);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const directoryStat = await lstat(directory);
	if (
		directoryStat.isSymbolicLink() ||
		!directoryStat.isDirectory() ||
		directoryStat.uid !== process.getuid?.()
	)
		throw new Error("Unsafe broker directory");
	await chmod(directory, 0o700);
	const registryPath = join(directory, "registry.json");
	const lockPath = join(directory, "startup.lock");
	const deadline = performance.now() + route.startupTimeoutMs;
	while (performance.now() < deadline) {
		signal.throwIfAborted();
		const prior = await readRegistry(registryPath);
		if (prior) {
			if (prior.key !== key || prior.root !== root) throw new Error("Broker registry identity mismatch");
			try {
				return await BrokerConnection.connect(prior, clientId, update);
			} catch {
				if (processExists(prior.pid)) {
					await sleep(100);
					continue;
				}
			}
		}
		let lock;
		try {
			lock = await open(lockPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await recoverAbandonedStartup(lockPath);
			await sleep(100);
			continue;
		}
		try {
			await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
			const current = await readRegistry(registryPath);
			if (current && current.generation !== prior?.generation) continue;
			if (current) await awaitRetiredGuard(current, signal);
			const socketDirectory = join(tmpdir(), `pi-lsp-${process.getuid?.() ?? "user"}`);
			await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
			const socketStat = await lstat(socketDirectory);
			if (socketStat.isSymbolicLink() || socketStat.uid !== (process.getuid?.() ?? socketStat.uid))
				throw new Error("Unsafe LSP socket directory");
			await chmod(socketDirectory, 0o700);
			const generation = randomUUID();
			const runDirectory = join(directory, generation);
			await mkdir(runDirectory, { mode: 0o700 });
			const launch: BrokerLaunch = {
				version: 1,
				key,
				generation,
				token: randomBytes(32).toString("hex"),
				socket: join(socketDirectory, `${generation.slice(0, 18)}.sock`),
				directory: runDirectory,
				root,
				route,
			};
			const launchPath = join(runDirectory, "launch.json");
			await writeFile(launchPath, JSON.stringify(launch), { mode: 0o600, flag: "wx" });
			const executableName = process.execPath.split("/").at(-1) ?? "";
			const isSupportedRuntime = /^(node|bun)(\.exe)?$/.test(executableName);
			const runtime = isSupportedRuntime ? process.execPath : "node";
			const child = spawn(
				runtime,
				[fileURLToPath(new URL("./lsp-broker-host.mjs", import.meta.url)), launchPath],
				{
					detached: true,
					stdio: ["ignore", "ignore", "ignore", "ipc"],
					cwd: root,
					env: { ...serverEnvironment(route), HOME: process.env.HOME ?? homedir() },
				},
			);
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					child.kill("SIGTERM");
					reject(new Error("Broker did not create its socket"));
				}, 10000);
				child.once("exit", (code) => {
					clearTimeout(timer);
					reject(new Error(`Broker exited during startup (${code})`));
				});
				child.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.on("message", (message) => {
					const event = message as { kind: string; reason?: string };
					if (event.kind === "listening") {
						clearTimeout(timer);
						resolve();
					}
					if (event.kind === "failed") {
						clearTimeout(timer);
						reject(new Error(event.reason));
					}
				});
			});
			child.unref();
			if (signal.aborted) {
				child.kill("SIGTERM");
				signal.throwIfAborted();
			}
			const registry: BrokerRegistry = { ...launch, pid: child.pid! };
			const temporaryRegistry = join(directory, `${generation}.registry.tmp`);
			await writeFile(temporaryRegistry, JSON.stringify(registry), { mode: 0o600, flag: "wx" });
			await rename(temporaryRegistry, registryPath);
			return await BrokerConnection.connect(registry, clientId, update);
		} finally {
			await lock.close();
			await unlink(lockPath);
		}
	}
	throw new Error(
		"Shared LSP startup is locked or the previous broker has not retired; inspect /quality lsp status before retrying",
	);
}
