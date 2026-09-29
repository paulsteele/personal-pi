import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { attachBroker, type BrokerConnection } from "./lsp-broker-registry.js";
import { canonicalPath, inside } from "./capture.js";
import { digest } from "./proposal.js";
import {
	loadLspProfile,
	matchingLspRoutes,
	resolveLspProject,
	type LspProject,
	type LspRoute,
	type StoredLspProfile,
} from "./lsp-profile.js";
import { discoverLspFiles, type LspValidation } from "./lsp-setup.js";
import type { LspCheckResult, LspServerStatus } from "./lsp-diagnostics.js";

export class LspManager {
	private readonly instanceId = randomUUID();
	private readonly connections = new Map<string, Promise<BrokerConnection>>();
	private readonly statuses = new Map<string, LspServerStatus>();
	private lifetime = new AbortController();
	private epoch = 0;
	private profile?: StoredLspProfile;
	project?: LspProject;
	private trusted = false;
	private refreshing?: Promise<boolean>;
	constructor(
		readonly agentDir: string,
		private readonly changed: () => void,
	) {}
	get revision(): number {
		return this.epoch;
	}
	get configRevision(): string {
		return this.profile?.revision ?? "unconfigured";
	}
	get configured(): boolean {
		return Boolean(this.profile?.profile.enabled && this.profile.profile.routes.length);
	}
	get header(): LspServerStatus[] {
		return [...this.statuses.values()];
	}

	async start(cwd: string, trusted: boolean): Promise<void> {
		if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
		this.trusted = trusted;
		this.project = await resolveLspProject(cwd, this.agentDir);
		this.profile = await loadLspProfile(this.agentDir, this.project);
		this.statuses.clear();
		for (const route of this.profile?.profile.routes ?? []) {
			this.statuses.set(route.id, {
				id: route.id,
				name: route.preset,
				root: route.root,
				phase: !this.profile?.profile.enabled ? "disabled" : trusted ? "connecting" : "failed",
				clients: 0,
				...(!trusted ? { reason: "Project is not trusted" } : {}),
			});
			if (trusted && this.profile?.profile.enabled) void this.connection(route, this.project).catch(() => {});
		}
		this.changed();
	}

	private connection(route: LspRoute, project: LspProject): Promise<BrokerConnection> {
		const existing = this.connections.get(route.id);
		if (existing) return existing;
		const root = canonicalPath(resolve(project.root, route.root));
		if (!inside(project.root, root)) return Promise.reject(new Error("Workspace escaped configured project"));
		const owner = this.lifetime;
		const deadline = AbortSignal.any([owner.signal, AbortSignal.timeout(route.startupTimeoutMs)]);
		const connection = attachBroker(
			this.agentDir,
			root,
			route,
			`${this.instanceId}:${route.id}`,
			(status, invalidated) => {
				if (owner !== this.lifetime || owner.signal.aborted) return;
				this.statuses.set(route.id, { ...status, id: route.id, root: route.root });
				if (invalidated) this.epoch++;
				this.changed();
			},
			deadline,
		)
			.then(async (connection) => {
				if (owner.signal.aborted) {
					await connection.close();
					throw new Error("LSP owner retired");
				}
				return connection;
			})
			.catch((error) => {
				if (owner === this.lifetime && !owner.signal.aborted) {
					this.connections.delete(route.id);
					this.statuses.set(route.id, {
						id: route.id,
						name: route.preset,
						root: route.root,
						phase: "failed",
						clients: 0,
						reason: String(error),
					});
					this.changed();
				}
				throw error;
			});
		this.connections.set(route.id, connection);
		return connection;
	}

	refreshConfiguration(): Promise<boolean> {
		this.refreshing ??= this.reloadChangedProfile().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}
	private async reloadChangedProfile(): Promise<boolean> {
		if (!this.project) return false;
		const latest = await loadLspProfile(this.agentDir, this.project);
		if (latest?.revision === this.profile?.revision) return false;
		const { root } = this.project;
		await this.stop();
		this.lifetime = new AbortController();
		await this.start(root, this.trusted);
		this.epoch++;
		return true;
	}

	async check(
		files: { path: string; after: string | null }[],
		signal: AbortSignal,
	): Promise<LspCheckResult | undefined> {
		await this.refreshConfiguration();
		if (!this.project || !this.profile?.profile.enabled) return undefined;
		const grouped = new Map<LspRoute, { path: string; hash: string; languageId: string }[]>();
		for (const file of files) {
			if (file.after === null) continue;
			for (const route of matchingLspRoutes(this.profile.profile, this.project, file.path)) {
				const languageId = Object.entries(route.extensions).find(([extension]) =>
					file.path.endsWith(extension),
				)![1];
				const group = grouped.get(route) ?? [];
				group.push({ path: file.path, hash: digest(file.after), languageId });
				grouped.set(route, group);
			}
		}
		if (!grouped.size) return undefined;
		if (!this.trusted) return { kind: "unavailable", reason: "Project is not trusted for LSP analysis" };
		const checkedRoutes: {
			connection: BrokerConnection;
			result: Extract<LspCheckResult, { kind: "checked" }>;
		}[] = [];
		for (const [route, requests] of grouped) {
			try {
				const connection = await this.connection(route, this.project);
				const deadline = AbortSignal.any([
					signal,
					this.lifetime.signal,
					AbortSignal.timeout(route.startupTimeoutMs + route.diagnosticTimeoutMs * requests.length),
				]);
				const result = await connection.check(requests, deadline);
				if (result.kind !== "checked") return result;
				checkedRoutes.push({
					connection,
					result: {
						...result,
						findings: result.findings.map((finding) => ({ ...finding, serverId: route.id })),
					},
				});
			} catch (error) {
				return signal.aborted
					? { kind: "cancelled", reason: "Check cancelled" }
					: { kind: "unavailable", reason: String(error) };
			}
		}
		const changedAfterCheck = checkedRoutes.some(({ connection, result }) => {
			const status = connection.status;
			return (
				status?.generation !== result.generation || status.workspaceRevision !== result.workspaceRevision
			);
		});
		if (changedAfterCheck)
			return { kind: "stale", reason: "A checked workspace changed while another server was checking" };
		const results = checkedRoutes.map(({ result }) => result);
		const findings = results.flatMap((result) => result.findings);
		const generation = results.map((result) => result.generation).join(";");
		const hashes = Object.assign({}, ...results.map((result) => result.hashes));
		const elapsedMs = results.reduce((totalElapsedMs, result) => totalElapsedMs + result.elapsedMs, 0);
		return { kind: "checked", findings, generation, workspaceRevision: this.epoch, hashes, elapsedMs };
	}

	async validate(route: LspRoute, project: LspProject, signal: AbortSignal): Promise<LspValidation> {
		const root = canonicalPath(resolve(project.root, route.root));
		if (!inside(project.root, root)) {
			return { ready: false, summary: "Workspace outside project" };
		}
		const discovery = await discoverLspFiles(root, signal);
		const file = discovery.files.find((file) =>
			Object.keys(route.extensions).some((extension) => file.endsWith(extension)),
		);
		if (!file) {
			const extensions = Object.keys(route.extensions).join(", ");
			return {
				ready: false,
				summary: discovery.truncated
					? `Source discovery reached its scan limit in ${root} before finding a file matching ${extensions}; narrow the workspace root in /quality lsp setup edit, then retry approval`
					: `No representative source file matching ${extensions} found in ${root}; select a workspace containing source`,
			};
		}
		const connection = await attachBroker(
			this.agentDir,
			root,
			route,
			`${this.instanceId}:doctor:${randomUUID()}`,
			() => {},
			signal,
		);
		try {
			const path = canonicalPath(resolve(root, file));
			const text = await readFile(path, "utf8");
			const languageId = Object.entries(route.extensions).find(([extension]) => file.endsWith(extension))![1];
			const result = await connection.check(
				[{ path, hash: digest(text), languageId }],
				AbortSignal.any([signal, AbortSignal.timeout(route.startupTimeoutMs + route.diagnosticTimeoutMs)]),
			);
			return result.kind === "checked"
				? { ready: true, summary: `Operational; ${result.findings.length} diagnostics in ${file}` }
				: { ready: false, summary: result.reason };
		} finally {
			await connection.close();
		}
	}
	async restart(id: string | undefined, signal: AbortSignal): Promise<void> {
		if (!this.project || !this.profile) throw new Error("No configured language servers");
		const routes = this.profile.profile.routes.filter((route) => !id || route.id === id);
		if (!routes.length) throw new Error(`Unknown configured server: ${id}`);
		for (const route of routes) {
			if (this.statuses.get(route.id)?.phase === "failed") {
				await this.connections
					.get(route.id)
					?.then((connection) => connection.close())
					.catch(() => {});
				this.connections.delete(route.id);
			}
			const connection = await this.connection(route, this.project);
			await connection.restart(signal);
		}
	}
	statusText(): string {
		if (!this.profile) return "LSP unconfigured — /quality lsp setup";
		if (!this.profile.profile.routes.length) return "LSP: no configured servers — /quality lsp setup";
		return this.header
			.map(
				(status) =>
					`${status.id} (${status.name}) · ${status.root} · ${status.phase} · ${status.clients} client(s)\n${this.profile?.profile.routes.find((route) => route.id === status.id)?.command ?? ""}\nGeneration: ${status.generation ?? "not started"}${status.reason ? `\n${status.reason}` : ""}`,
			)
			.join("\n");
	}
	async stop(): Promise<void> {
		this.epoch++;
		this.lifetime.abort();
		const connections = [...this.connections.values()];
		this.connections.clear();
		await Promise.allSettled(connections.map(async (pending) => (await pending).close()));
		for (const [id, status] of this.statuses)
			this.statuses.set(id, { ...status, phase: "stopped", clients: 0, queued: false });
		this.changed();
	}
}
