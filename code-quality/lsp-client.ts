import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { matchesGlob, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	CancellationTokenSource,
	WorkDoneProgress,
	createProtocolConnection,
	type Diagnostic,
	type DiagnosticOptions,
	type InitializeResult,
	type ProtocolConnection,
	type PublishDiagnosticsParams,
	type Registration,
	type RegistrationParams,
} from "vscode-languageserver-protocol/node";
import {
	diagnosticFinding,
	uniqueFindings,
	type LspFinding,
	type LspServerPhase,
} from "./lsp-diagnostics.js";
import type { LspRoute } from "./lsp-profile.js";

export class LspClient {
	private connection!: ProtocolConnection;
	private guard?: ChildProcess;
	private closed?: Promise<void>;
	private initialization?: InitializeResult;
	private readonly registrations = new Map<string, Registration>();
	private providerRevision = 0;
	private readonly reports = new Map<
		string,
		{ resultId: string; items: Diagnostic[]; documentVersion: number }
	>();
	private readonly versions = new Map<string, number>();
	private readonly textByUri = new Map<string, string>();
	private readonly pushed = new Map<string, PublishDiagnosticsParams>();
	private readonly progress = new Map<string | number, string>();
	private readonly progressSubscriptions = new Map<string | number, { dispose(): void }>();
	private flycheckStarts = 0;
	private flycheckEnds = 0;
	private flycheckFailure?: string;
	private projectsLoaded = false;
	private rustReady = false;
	private failure?: string;
	private retiring = false;
	private stderr = "";
	private serverPid?: number;
	private readonly lifetime = new AbortController();

	constructor(
		readonly route: LspRoute,
		readonly root: string,
		private readonly status: (phase: LspServerPhase, reason?: string) => void,
		private readonly refresh: () => void,
		private readonly guardRecord?: string,
	) {}

	async start(): Promise<void> {
		this.status("starting");
		const runtime = /^(node|bun)(\.exe)?$/.test(process.execPath.split("/").at(-1) ?? "")
			? process.execPath
			: "node";
		const guard = spawn(
			runtime,
			[
				fileURLToPath(new URL("./lsp-process-guard.mjs", import.meta.url)),
				this.route.command,
				...this.route.args,
			],
			{
				cwd: this.root,
				env: { ...process.env, ...this.route.env },
				stdio: ["pipe", "pipe", "pipe", "ipc"],
				detached: true,
			},
		);
		this.guard = guard;
		this.closed = new Promise((resolve) => guard.once("close", () => resolve()));
		guard.on("error", (error) => this.fail(error.message));
		if (guard.pid && this.guardRecord)
			await writeFile(this.guardRecord, JSON.stringify({ pid: guard.pid }), { mode: 0o600 });
		guard.on("message", (message) => {
			const event = message as { kind: string; pid?: number; reason?: string };
			if (event.kind === "started") this.serverPid = event.pid;
			if (event.kind === "failed" || (event.kind === "exited" && !this.retiring))
				this.fail(event.reason ?? "Language server exited");
		});
		guard.on("close", () => {
			if (!this.retiring) this.fail("Language server guard closed");
		});
		guard.stderr!.on("data", (chunk) => {
			this.stderr = (this.stderr + String(chunk)).slice(-8000);
		});
		this.connection = createProtocolConnection(guard.stdout!, guard.stdin!);
		this.connection.onError(([error]) => this.fail(error.message));
		this.connection.onRequest("client/registerCapability", ({ registrations }: RegistrationParams) => {
			if (this.registrations.size + registrations.length > 256)
				throw new Error("Language server registered too many capabilities");
			for (const registration of registrations) this.registrations.set(registration.id, registration);
			this.providerRevision++;
			this.refresh();
			return null;
		});
		this.connection.onRequest(
			"client/unregisterCapability",
			(params: { unregisterations: { id: string }[] }) => {
				for (const registration of params.unregisterations) this.registrations.delete(registration.id);
				this.providerRevision++;
				this.refresh();
				return null;
			},
		);
		this.connection.onRequest("workspace/configuration", (params: { items: { section?: string }[] }) =>
			params.items.map(({ section }) => this.setting(section)),
		);
		this.connection.onRequest("workspace/workspaceFolders", () => [
			{ uri: pathToFileURL(this.root).href, name: this.route.id },
		]);
		this.connection.onRequest("workspace/applyEdit", () => ({
			applied: false,
			failureReason: "Quality checks never apply server edits",
		}));
		this.connection.onRequest("window/showMessageRequest", () => null);
		this.connection.onRequest("window/workDoneProgress/create", (params: { token: string | number }) => {
			this.progressSubscriptions.get(params.token)?.dispose();
			const subscription = this.connection.onProgress(WorkDoneProgress.type, params.token, (value) => {
				if (value.kind === "end") this.progress.delete(params.token);
				else this.progress.set(params.token, value.kind);
				if (String(params.token).startsWith("rust-analyzer/flycheck/")) {
					if (value.kind === "begin") this.flycheckStarts++;
					if (value.kind === "end") this.flycheckEnds++;
				}
				if (value.kind === "end") {
					this.progressSubscriptions.get(params.token)?.dispose();
					this.progressSubscriptions.delete(params.token);
				}
			});
			this.progressSubscriptions.set(params.token, subscription);
			return null;
		});
		this.connection.onRequest("workspace/diagnostic/refresh", () => {
			this.reports.clear();
			this.refresh();
			return null;
		});
		this.connection.onNotification("workspace/projectInitializationComplete", () => {
			this.projectsLoaded = true;
		});
		this.connection.onNotification(
			"experimental/serverStatus",
			(params: { health: string; quiescent: boolean; message?: string }) => {
				this.rustReady = params.quiescent && params.health === "ok";
				if (params.health === "error") this.fail(params.message ?? "Rust workspace failed to load");
			},
		);
		this.connection.onNotification("window/logMessage", (params: { type: number; message: string }) => {
			const isFlycheckFailure = /(?:cargo check failed|flycheck.*failed|failed to run)/i.test(params.message);
			if (this.route.preset === "rust-analyzer" && isFlycheckFailure) this.flycheckFailure = params.message;
		});
		this.connection.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) => {
			if (!this.versions.has(params.uri)) return;
			this.pushed.set(params.uri, params);
		});
		this.connection.listen();
		this.status("loading");
		this.initialization = await this.request<InitializeResult>(
			"initialize",
			{
				processId: process.pid,
				rootUri: pathToFileURL(this.root).href,
				workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: this.route.id }],
				clientInfo: { name: "pi-quality-broker", version: "1" },
				initializationOptions: this.route.initializationOptions,
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
			},
			this.route.startupTimeoutMs,
		);
		const positionEncoding = this.initialization.capabilities.positionEncoding;
		if (positionEncoding && positionEncoding !== "utf-16")
			throw new Error(`Unsupported negotiated position encoding: ${positionEncoding}`);
		await this.connection.sendNotification("initialized", {});
		await this.connection.sendNotification("workspace/didChangeConfiguration", {
			settings: this.route.settings,
		});
		if (this.route.preset === "roslyn") {
			if (!this.route.project) throw new Error("Select a C# project or solution in setup");
			const uri = pathToFileURL(resolve(this.root, this.route.project)).href;
			if (/\.slnx?$/.test(this.route.project))
				await this.connection.sendNotification("solution/open", { solution: uri });
			else await this.connection.sendNotification("project/open", { projects: [uri] });
			await this.waitFor(() => this.projectsLoaded, "C# project initialization", this.route.startupTimeoutMs);
		}
		if (this.route.preset === "rust-analyzer")
			await this.waitFor(() => this.rustReady, "Rust project initialization", this.route.startupTimeoutMs);
		if (this.route.preset !== "typescript")
			await this.waitFor(
				() => this.providers().length > 0,
				"diagnostic provider registration",
				this.route.startupTimeoutMs,
			);
		this.status("ready");
	}

	private setting(section?: string): unknown {
		if (!section) return this.route.settings;
		let value: unknown = this.route.settings;
		for (const key of section.split("."))
			value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
		return value ?? null;
	}
	private fail(reason: string): void {
		if (this.retiring) return;
		this.failure = reason;
		this.lifetime.abort();
		this.status("failed", reason);
	}
	private async waitFor(
		ready: () => boolean,
		description: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		const deadline = performance.now() + timeoutMs;
		while (!ready()) {
			if (this.failure) throw new Error(this.failure);
			this.lifetime.signal.throwIfAborted();
			signal?.throwIfAborted();
			if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
			await sleep(20);
		}
	}
	private async request<T>(
		method: string,
		params: object | undefined,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<T> {
		const cancellation = new CancellationTokenSource();
		const operationSignal = AbortSignal.any([
			this.lifetime.signal,
			...(signal ? [signal] : []),
			AbortSignal.timeout(timeoutMs),
		]);
		operationSignal.throwIfAborted();
		let abort!: () => void;
		const interrupted = new Promise<never>((_, reject) => {
			abort = () => {
				cancellation.cancel();
				reject(new Error(this.failure ?? `${method} interrupted or timed out`));
			};
			operationSignal.addEventListener("abort", abort, { once: true });
		});
		try {
			return await Promise.race([
				params === undefined
					? this.connection.sendRequest<T>(method, cancellation.token)
					: this.connection.sendRequest<T>(method, params, cancellation.token),
				interrupted,
			]);
		} finally {
			operationSignal.removeEventListener("abort", abort);
			cancellation.dispose();
		}
	}
	private matchesDocumentSelector(
		item: { language?: string; scheme?: string; pattern?: string },
		languageId: string,
		path?: string,
	): boolean {
		const languageMatches = !item.language || item.language === languageId;
		const schemeMatches = !item.scheme || item.scheme === "file";
		const pathMatches = !item.pattern || (path !== undefined && matchesGlob(path, item.pattern));
		return languageMatches && schemeMatches && pathMatches;
	}
	private providers(languageId?: string, path?: string): { identifier?: string; key: string }[] {
		const registered = [...this.registrations.values()]
			.filter((registration) => {
				if (registration.method !== "textDocument/diagnostic") return false;
				const selector = registration.registerOptions?.documentSelector as
					| { language?: string; scheme?: string; pattern?: string }[]
					| undefined;
				if (!languageId || !selector) return true;
				return selector.some((item) => this.matchesDocumentSelector(item, languageId, path));
			})
			.map((registration) => ({
				identifier: registration.registerOptions?.identifier as string | undefined,
				key: registration.id,
			}));
		const declared = this.initialization?.capabilities.diagnosticProvider as DiagnosticOptions | undefined;
		if (declared) registered.push({ identifier: declared.identifier, key: "static" });
		return registered;
	}

	async synchronize(path: string, languageId: string, text: string): Promise<void> {
		const uri = pathToFileURL(path).href;
		if (this.textByUri.get(uri) === text) return;
		if (!this.versions.has(uri) && this.versions.size >= 96) {
			const oldest = this.versions.keys().next().value!;
			await this.connection.sendNotification("textDocument/didClose", { textDocument: { uri: oldest } });
			this.versions.delete(oldest);
			this.textByUri.delete(oldest);
			this.pushed.delete(oldest);
			this.reports.clear();
		}
		const version = (this.versions.get(uri) ?? 0) + 1;
		this.versions.set(uri, version);
		if (version === 1)
			await this.connection.sendNotification("textDocument/didOpen", {
				textDocument: { uri, version, languageId, text },
			});
		else {
			const synchronization = this.initialization?.capabilities.textDocumentSync;
			const synchronizationKind =
				typeof synchronization === "object" ? synchronization.change : synchronization;
			const usesIncrementalSynchronization = synchronizationKind === 2;
			const previous = this.textByUri.get(uri) ?? "";
			const lines = previous.split("\n");
			const fullDocumentRange = {
				start: { line: 0, character: 0 },
				end: { line: lines.length - 1, character: lines.at(-1)!.length },
			};
			const replacement = usesIncrementalSynchronization ? { range: fullDocumentRange, text } : { text };
			await this.connection.sendNotification("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [replacement],
			});
		}
		this.textByUri.set(uri, text);
		await this.connection.sendNotification("textDocument/didSave", { textDocument: { uri }, text });
	}

	async diagnose(path: string, languageId: string, signal: AbortSignal): Promise<LspFinding[]> {
		const deadline = performance.now() + this.route.diagnosticTimeoutMs;
		for (;;) {
			const result = await this.diagnoseGeneration(path, languageId, signal);
			if (result) return result;
			signal.throwIfAborted();
			if (performance.now() >= deadline)
				throw new Error("Diagnostic providers did not stabilize before the deadline");
		}
	}

	private async diagnoseGeneration(
		path: string,
		languageId: string,
		signal: AbortSignal,
	): Promise<LspFinding[] | undefined> {
		if (this.failure) throw new Error(this.failure);
		const uri = pathToFileURL(path).href;
		const timeoutMs = this.route.diagnosticTimeoutMs;
		if (this.route.preset === "roslyn") {
			const deadline = performance.now() + timeoutMs;
			let member = false;
			while (!member && performance.now() < deadline) {
				const contexts = await this.request<{
					_vs_projectContexts?: { _vs_is_miscellaneous?: boolean }[];
				} | null>("textDocument/_vs_getProjectContexts", { _vs_textDocument: { uri } }, timeoutMs, signal);
				member = contexts?._vs_projectContexts?.some((project) => !project._vs_is_miscellaneous) ?? false;
				if (!member) await sleep(100);
			}
			if (!member)
				throw new Error("C# file is not in a loaded project; refusing a miscellaneous-file clean result");
		}
		if (this.route.preset === "typescript") return this.typeScriptDiagnostics(path, uri, signal);
		if (this.route.preset === "rust-analyzer") {
			const starts = this.flycheckStarts;
			const ends = this.flycheckEnds;
			this.flycheckFailure = undefined;
			await this.connection.sendNotification("rust-analyzer/runFlycheck", { textDocument: { uri } });
			await this.waitFor(
				() =>
					this.flycheckStarts > starts &&
					this.flycheckEnds > ends &&
					![...this.progress].some(
						([token, kind]) => String(token).startsWith("rust-analyzer/flycheck/") && kind !== "end",
					),
				"cargo check completion",
				timeoutMs,
				signal,
			);
		}
		if (this.flycheckFailure) throw new Error(this.flycheckFailure);
		const providerRevision = this.providerRevision;
		const providers = this.providers(languageId, path);
		if (this.route.preset === "rust-analyzer") this.reports.clear();
		if (!providers.length)
			throw new Error("No applicable pull diagnostic provider; this server cannot certify file checks");
		const findings: LspFinding[] = [];
		for (const provider of providers) {
			const reportKey = `${provider.key}:${uri}`;
			const cached = this.reports.get(reportKey);
			const previous = cached?.documentVersion === this.versions.get(uri) ? cached : undefined;
			const report = await this.request<{ kind: string; items?: Diagnostic[]; resultId?: string }>(
				"textDocument/diagnostic",
				{
					textDocument: { uri },
					identifier: provider.identifier,
					...(previous ? { previousResultId: previous.resultId } : {}),
				},
				timeoutMs,
				signal,
			);
			const goplsEmptyKindReport = this.route.preset === "gopls" && report.kind === "";
			const unchangedReport =
				report.kind === "unchanged" && previous && report.resultId === previous.resultId;
			const items = unchangedReport ? previous.items : report.items;
			if ((!unchangedReport && !goplsEmptyKindReport && report.kind !== "full") || !Array.isArray(items))
				throw new Error("Incomplete diagnostic report without a reusable result");
			if (report.resultId)
				this.reports.set(reportKey, {
					resultId: report.resultId,
					items,
					documentVersion: this.versions.get(uri)!,
				});
			findings.push(
				...items.map((diagnostic) => diagnosticFinding(path, this.route.id, diagnostic, provider.identifier)),
			);
		}
		if (this.route.preset === "rust-analyzer") {
			const pushed = this.pushed.get(uri);
			if (pushed && pushed.version !== undefined && pushed.version !== this.versions.get(uri))
				throw new Error("Stale rustc diagnostic generation");
			findings.push(
				...(pushed?.diagnostics ?? []).map((diagnostic) =>
					diagnosticFinding(path, this.route.id, diagnostic, "rustc"),
				),
			);
		}
		if (providerRevision !== this.providerRevision) return undefined;
		return uniqueFindings(findings);
	}

	private async typeScriptDiagnostics(path: string, uri: string, signal: AbortSignal): Promise<LspFinding[]> {
		const findings: LspFinding[] = [];
		for (const command of [
			"syntacticDiagnosticsSync",
			"semanticDiagnosticsSync",
			"suggestionDiagnosticsSync",
		]) {
			const response = await this.request<{
				success: boolean;
				body: {
					text: string;
					category: string;
					code: number;
					start: { line: number; offset: number };
					end: { line: number; offset: number };
				}[];
			}>(
				"workspace/executeCommand",
				{
					command: "typescript.tsserverRequest",
					arguments: [command, { file: uri }, { expectsResult: true, isAsync: false }],
				},
				this.route.diagnosticTimeoutMs,
				signal,
			);
			if (!response.success || !Array.isArray(response.body))
				throw new Error("TypeScript diagnostic request did not return a complete report");
			for (const item of response.body)
				findings.push(
					diagnosticFinding(
						path,
						this.route.id,
						{
							message: item.text,
							code: item.code,
							severity:
								item.category === "error"
									? 1
									: item.category === "warning"
										? 2
										: item.category === "message"
											? 3
											: 4,
							range: {
								start: { line: item.start.line - 1, character: item.start.offset - 1 },
								end: { line: item.end.line - 1, character: item.end.offset - 1 },
							},
						},
						command,
					),
				);
		}
		return findings;
	}

	async fileChanged(path: string, type: number): Promise<void> {
		this.reports.clear();
		const uri = pathToFileURL(path).href;
		if (this.versions.has(uri)) {
			if (type === 3) {
				await this.connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
				this.textByUri.delete(uri);
				this.versions.delete(uri);
				this.pushed.delete(uri);
				this.reports.clear();
			} else {
				const language = Object.entries(this.route.extensions).find(([extension]) =>
					path.endsWith(extension),
				)?.[1];
				if (language) await this.synchronize(path, language, await readFile(path, "utf8"));
			}
		}
		await this.connection.sendNotification("workspace/didChangeWatchedFiles", { changes: [{ uri, type }] });
	}

	async stop(): Promise<void> {
		if (this.retiring) return this.closed;
		this.retiring = true;
		this.status("stopping");
		try {
			if (this.connection && !this.failure) {
				await this.request("shutdown", undefined, 3000);
				await this.connection.sendNotification("exit");
			}
		} catch {}
		this.lifetime.abort();
		if (this.guard?.connected) this.guard.send({ kind: "stop" }, () => {});
		await Promise.race([this.closed, sleep(5000)]);
		for (const subscription of this.progressSubscriptions.values()) subscription.dispose();
		this.progressSubscriptions.clear();
		this.connection?.dispose();
		if (this.guard?.exitCode === null && this.guard.signalCode === null) {
			if (this.serverPid) {
				try {
					process.kill(-this.serverPid, "SIGKILL");
				} catch {}
			}
			this.guard.kill("SIGKILL");
			await Promise.race([this.closed, sleep(1000)]);
		}
		this.status("stopped");
	}
}
