import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	CancellationTokenSource,
	WorkDoneProgress,
	createProtocolConnection,
	type InitializeResult,
	type ProtocolConnection,
	type RegistrationParams,
} from "vscode-languageserver-protocol/node";

export interface ProbeServer {
	name: string;
	command: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	initializationOptions?: unknown;
	settings?: Record<string, unknown>;
}

export interface ProbeEvent {
	elapsedMs: number;
	method: string;
	params: unknown;
}

async function processGroupExists(pid: number): Promise<boolean> {
	try {
		await promisify(execFile)("ps", ["-g", String(pid), "-o", "pid="]);
		return true;
	} catch (error) {
		if ((error as { code?: number }).code === 1) return false;
		throw error;
	}
}

export class LspProbe {
	readonly events: ProbeEvent[] = [];
	readonly registrations = new Map<string, RegistrationParams["registrations"][number]>();
	readonly startedAt = performance.now();
	readonly connection: ProtocolConnection;
	readonly child: ChildProcessWithoutNullStreams;
	private readonly closed: Promise<void>;
	private stderr = "";
	private readonly versions = new Map<string, number>();
	private stopped = false;

	constructor(
		readonly server: ProbeServer,
		readonly root: string,
	) {
		this.child = spawn(server.command, server.args, {
			cwd: root,
			env: { ...process.env, ...server.env },
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.closed = new Promise((resolve) => {
			this.child.once("close", () => resolve());
		});
		this.child.on("error", (error) => this.record("process/error", error.message));
		this.child.stderr.on("data", (chunk) => {
			this.stderr = (this.stderr + String(chunk)).slice(-64_000);
		});
		this.connection = createProtocolConnection(this.child.stdout, this.child.stdin);
		this.connection.onUnhandledNotification(({ method, params }) => this.record(method, params));
		this.connection.onRequest("client/registerCapability", (params: RegistrationParams) => {
			this.record("client/registerCapability", params);
			for (const registration of params.registrations) this.registrations.set(registration.id, registration);
			return null;
		});
		this.connection.onRequest(
			"client/unregisterCapability",
			(params: { unregisterations: { id: string }[] }) => {
				for (const registration of params.unregisterations) this.registrations.delete(registration.id);
				return null;
			},
		);
		this.connection.onRequest("workspace/configuration", (params: { items: { section?: string }[] }) => {
			this.record("workspace/configuration", params);
			return params.items.map(({ section }) => {
				if (!section) return server.settings ?? {};
				let value: unknown = server.settings;
				for (const key of section.split(".")) {
					value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
				}
				return value ?? null;
			});
		});
		this.connection.onRequest("workspace/workspaceFolders", () => [
			{ uri: pathToFileURL(root).href, name: "probe" },
		]);
		this.connection.onRequest("window/workDoneProgress/create", (params: { token: string | number }) => {
			this.record("window/workDoneProgress/create", params);
			this.connection.onProgress(WorkDoneProgress.type, params.token, (value) => {
				this.record("$/progress", { token: params.token, value });
			});
			return null;
		});
		this.connection.onRequest("workspace/diagnostic/refresh", () => {
			this.record("workspace/diagnostic/refresh", null);
			return null;
		});
		this.connection.onRequest("workspace/applyEdit", () => ({
			applied: false,
			failureReason: "Diagnostics-only probe",
		}));
		this.connection.listen();
	}

	record(method: string, params: unknown): void {
		this.events.push({ elapsedMs: Math.round(performance.now() - this.startedAt), method, params });
		if (this.events.length > 10_000) throw new Error("Probe event budget exceeded");
	}

	async request<T>(method: string, params?: object, timeoutMs = 60_000): Promise<T> {
		const cancellation = new CancellationTokenSource();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const pending =
				params === undefined
					? this.connection.sendRequest<T>(method, cancellation.token)
					: this.connection.sendRequest<T>(method, params, cancellation.token);
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					cancellation.cancel();
					reject(new Error(`${this.server.name}: ${method} timed out after ${timeoutMs} ms`));
				}, timeoutMs);
			});
			const result = await Promise.race([pending, deadline]);
			this.record(`response/${method}`, result);
			return result;
		} finally {
			clearTimeout(timer);
			cancellation.dispose();
		}
	}

	async initialize(): Promise<InitializeResult> {
		const result = await this.request<InitializeResult>("initialize", {
			processId: process.pid,
			clientInfo: { name: "pi-quality-compatibility-probe", version: "1" },
			rootUri: pathToFileURL(this.root).href,
			workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: "probe" }],
			initializationOptions: this.server.initializationOptions,
			capabilities: {
				general: { positionEncodings: ["utf-16"] },
				workspace: { configuration: true, workspaceFolders: true, diagnostics: { refreshSupport: true } },
				window: { workDoneProgress: true },
				textDocument: {
					synchronization: { dynamicRegistration: true, didSave: true },
					diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
					publishDiagnostics: {
						versionSupport: true,
						relatedInformation: true,
						tagSupport: { valueSet: [1, 2] },
					},
				},
				experimental: { serverStatusNotification: true },
			},
		});
		await this.connection.sendNotification("initialized", {});
		await this.connection.sendNotification("workspace/didChangeConfiguration", {
			settings: this.server.settings ?? {},
		});
		return result;
	}

	async sync(relativePath: string, languageId: string, text: string): Promise<number> {
		const path = join(this.root, relativePath);
		const uri = pathToFileURL(path).href;
		await writeFile(path, text);
		const version = (this.versions.get(uri) ?? 0) + 1;
		this.versions.set(uri, version);
		if (version === 1) {
			await this.connection.sendNotification("textDocument/didOpen", {
				textDocument: { uri, languageId, text, version },
			});
		} else {
			await this.connection.sendNotification("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [{ text }],
			});
		}
		await this.connection.sendNotification("textDocument/didSave", { textDocument: { uri }, text });
		return version;
	}

	async waitUntil(description: string, ready: () => boolean, timeoutMs = 60_000): Promise<void> {
		const deadline = performance.now() + timeoutMs;
		while (!ready()) {
			if (performance.now() >= deadline)
				throw new Error(`${this.server.name}: waiting for ${description} timed out`);
			if (this.child.exitCode !== null || this.child.signalCode !== null)
				throw new Error(`${this.server.name}: server exited`);
			await sleep(20);
		}
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		try {
			if (this.child.exitCode === null && this.child.signalCode === null) {
				await this.request("shutdown", undefined, 3_000);
				await this.connection.sendNotification("exit");
			}
		} catch (error) {
			this.record("shutdown/error", String(error));
		} finally {
			await Promise.race([this.closed, sleep(300)]);
			await this.killGroup("SIGTERM");
			await sleep(100);
			await this.killGroup("SIGKILL");
			await Promise.race([this.closed, sleep(3_000)]);
			this.connection.dispose();
			if (this.child.exitCode === null && this.child.signalCode === null) {
				throw new Error(`${this.server.name}: child did not exit after termination`);
			}
			this.record("process/closed", { exitCode: this.child.exitCode, signal: this.child.signalCode });
			await writeFile(
				join(this.root, "probe-trace.json"),
				JSON.stringify({ server: this.server.name, events: this.events, stderr: this.stderr }, null, 2),
			);
		}
	}

	private async killGroup(signal: NodeJS.Signals): Promise<void> {
		if (!this.child.pid || !(await processGroupExists(this.child.pid))) return;
		try {
			process.kill(-this.child.pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
}
