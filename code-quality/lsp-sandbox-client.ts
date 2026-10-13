import type { QualitySandbox } from "./sandbox.js";
import type { LspRoute } from "./lsp-profile.js";
import { LspClient } from "./lsp-client.js";
import { randomUUID } from "node:crypto";
import type { LspFinding, LspServerPhase } from "./lsp-diagnostics.js";

export class SandboxLspClient {
	private readonly client: LspClient;
	private readonly documents = new Map<string, { languageId: string; text: string }>();
	private workspacePoll?: ReturnType<typeof setInterval>;
	private synchronization: Promise<void> = Promise.resolve();
	private retiring = false;
	private workspaceRevision = 0;
	private polling = false;
	private readonly processRecord = `/tmp/pi-sandbox-processes/lsp-${randomUUID()}`;
	constructor(
		readonly sandbox: QualitySandbox,
		readonly route: LspRoute,
		readonly root: string,
		status: (phase: LspServerPhase, reason?: string) => void = () => {},
		private readonly refresh: () => void = () => {},
		private readonly ownerSignal?: AbortSignal,
	) {
		const environment = sandbox.session.environment;
		const args = ["exec", "-i", "--user", environment.user, "--workdir", root];
		for (const [name, value] of Object.entries({ ...environment.remoteEnvironment, ...route.env })) {
			args.push("--env", `${name}=${value}`);
		}
		args.push(
			environment.container,
			"python3",
			"-u",
			"-c",
			sandbox.session.processSupervisor,
			this.processRecord,
			route.command,
			...route.args,
		);
		this.client = new LspClient(route, root, status, refresh, undefined, {
			command: "podman",
			args,
			cwd: process.cwd(),
			env: { PATH: process.env.PATH, HOME: process.env.HOME },
			clientProcessId: null,
			readFile: async (path) => (await sandbox.session.filesystem.read(path)).toString("utf8"),
		});
	}
	async start(): Promise<void> {
		this.ownerSignal?.throwIfAborted();
		const abort = () => {
			void this.client.stop();
		};
		this.ownerSignal?.addEventListener("abort", abort, { once: true });
		try {
			await this.client.start();
			this.ownerSignal?.throwIfAborted();
			this.workspacePoll = setInterval(() => {
				const hasOpenDocuments = this.documents.size > 0;
				const shouldSkipPoll = this.retiring || this.polling || !hasOpenDocuments;
				if (shouldSkipPoll) {
					return;
				}
				this.polling = true;
				void this.refreshOpenDocuments(this.ownerSignal)
					.catch(() => this.refresh())
					.finally(() => {
						this.polling = false;
					});
			}, 1000);
			this.workspacePoll.unref();
		} finally {
			this.ownerSignal?.removeEventListener("abort", abort);
		}
	}
	private refreshOpenDocuments(signal?: AbortSignal): Promise<void> {
		this.synchronization = this.synchronization
			.catch(() => {})
			.then(async () => {
				if (this.retiring) {
					return;
				}
				for (const [openPath, document] of this.documents) {
					let current: string;
					try {
						current = (await this.sandbox.session.filesystem.read(openPath, signal)).toString();
					} catch (error) {
						if (!String(error).includes("FileNotFoundError")) {
							throw error;
						}
						this.workspaceRevision++;
						await this.client.fileChanged(openPath, 3);
						this.documents.delete(openPath);
						this.refresh();
						continue;
					}
					if (current !== document.text) {
						this.workspaceRevision++;
						await this.client.fileChanged(openPath, 2);
						this.documents.set(openPath, { ...document, text: current });
						this.refresh();
					}
				}
			});
		return this.synchronization;
	}

	async refreshWorkspace(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (this.retiring) {
			throw new Error("LSP workspace belongs to a retired client");
		}
		await this.refreshOpenDocuments(signal);
		signal.throwIfAborted();
		if (this.retiring) {
			throw new Error("LSP workspace belongs to a retired client");
		}
	}

	async check(path: string, languageId: string, text: string, signal: AbortSignal): Promise<LspFinding[]> {
		await this.refreshOpenDocuments(signal);
		await this.client.synchronize(path, languageId, text);
		this.documents.set(path, { languageId, text });
		const checkedWorkspaceRevision = this.workspaceRevision;
		const checkedDocuments = new Map(this.documents);
		const findings = await this.client.diagnose(path, languageId, signal);
		for (const [openPath, document] of checkedDocuments) {
			const current = (await this.sandbox.session.filesystem.read(openPath, signal)).toString();
			if (current !== document.text) {
				this.refresh();
				throw new Error("Guest dependency changed during LSP diagnostics");
			}
		}
		if (this.retiring || checkedWorkspaceRevision !== this.workspaceRevision) {
			throw new Error("Guest workspace changed during LSP diagnostics");
		}
		return findings;
	}
	async stop(): Promise<void> {
		this.retiring = true;
		clearInterval(this.workspacePoll);
		this.documents.clear();
		const killProcessGroupScript = `
import os
import pathlib
import signal
import sys

process_record = pathlib.Path(sys.argv[1])
if process_record.exists():
    os.killpg(int(process_record.read_text()), signal.SIGKILL)
`;
		try {
			if (this.sandbox.session.terminateProcessGroup) {
				await this.sandbox.session.terminateProcessGroup(this.processRecord).catch(() => {});
			} else {
				await this.sandbox.session
					.execute({
						command: ["python3", "-c", killProcessGroupScript, this.processRecord],
						timeoutMs: 5000,
						signal: AbortSignal.timeout(5000),
					})
					.catch(() => {});
			}
		} finally {
			await this.client.stop();
		}
	}
}
