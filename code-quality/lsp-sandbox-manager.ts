import { randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import type { LspCheckResult, LspServerStatus } from "./lsp-diagnostics.js";
import {
	loadLspProfile,
	resolveLspProject,
	type LspProject,
	type LspRoute,
	type StoredLspProfile,
} from "./lsp-profile.js";
import { digest } from "./proposal.js";
import { qualitySandbox, guestLspProjectRoot, type QualitySandbox } from "./sandbox.js";
import { SandboxLspClient } from "./lsp-sandbox-client.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { automaticLspRoute } from "./lsp-auto-routes.js";
import { discoverSandboxLspFiles } from "./lsp-sandbox-discovery.js";
import { LSP_PRESETS } from "./lsp-presets.js";

async function locateCargoWorkspaceManifest(
	sandbox: QualitySandbox,
	cwd: string,
	fallbackCargo: string,
	signal: AbortSignal,
) {
	const command = [
		'cargo_executable="$1"',
		"if command -v cargo >/dev/null 2>&1; then cargo_executable=cargo; fi",
		'exec "$cargo_executable" locate-project --workspace --message-format plain',
	].join("\n");
	return sandbox.session.execute({ command: ["sh", "-c", command, "sh", fallbackCargo], cwd, signal });
}

interface PendingClientLaunch {
	promise: Promise<SandboxLspClient>;
	controller: AbortController;
	waiters: number;
}

function routeMatchesFile(route: LspRoute, root: string, path: string): boolean {
	return (path === root || path.startsWith(`${root}/`)) &&
		Object.keys(route.extensions).some((extension) => path.endsWith(extension));
}

export class SandboxLspManager {
	private profile?: StoredLspProfile;
	private project?: LspProject;
	private clients = new Map<string, SandboxLspClient>();
	private pendingClients = new Map<string, PendingClientLaunch>();
	private clientLifetime = new AbortController();
	private statuses = new Map<string, LspServerStatus>();
	private containerGeneration = 0;
	private epoch = 0;
	private sandbox?: QualitySandbox;
	private automaticChecksEnabled = true;
	private trusted = false;
	private automaticRoutes = new Map<string, LspRoute>();
	private discoveryRevision?: string;
	private releaseRetirementListener?: () => void;
	constructor(
		readonly pi: ExtensionAPI,
		readonly agentDir: string,
		readonly changed: () => void,
		private readonly currentTrust?: () => boolean,
	) {}
	get revision(): number {
		return this.epoch;
	}
	get configRevision(): string {
		return digest(
			JSON.stringify([
				this.profile?.revision ?? "automatic",
				this.sandbox?.session.environment.toolInventory?.revision,
				[...this.automaticRoutes.values()],
			]),
		);
	}
	get header(): LspServerStatus[] {
		return [...this.statuses.values()];
	}
	async start(cwd: string, trusted: boolean, automaticChecksEnabled = true): Promise<void> {
		await this.stop();
		this.automaticChecksEnabled = automaticChecksEnabled;
		this.trusted = trusted;
		this.automaticRoutes.clear();
		this.discoveryRevision = undefined;
		this.project = await resolveLspProject(cwd, this.agentDir);
		this.profile = await loadLspProfile(this.agentDir, this.project);
		this.statuses.clear();
		const profileEnabled = this.profile?.profile.enabled !== false;
		for (const route of this.profile?.profile.routes ?? []) {
			this.statuses.set(route.id, {
				id: route.id,
				name: route.preset,
				root: route.root,
				phase: !profileEnabled ? "disabled" : automaticChecksEnabled ? "connecting" : "stopped",
				clients: 0,
				...(!automaticChecksEnabled && profileEnabled ? { reason: "Suspended because quality is off" } : {}),
			});
		}
		this.changed();
		if (!profileEnabled || !automaticChecksEnabled) {
			return;
		}
		if (!trusted) {
			throw new Error("Trust this project before LSP analysis");
		}
		await this.attachSandbox();
		for (const route of this.profile?.profile.routes ?? []) {
			await this.client(this.resolveManagedRoute(route));
		}
	}
	private async attachSandbox(): Promise<void> {
		const sandbox = qualitySandbox(this.pi);
		if (sandbox === this.sandbox && sandbox.session.generation === this.containerGeneration) {
			return;
		}
		await this.stop();
		this.releaseRetirementListener?.();
		this.sandbox = sandbox;
		this.containerGeneration = sandbox.session.generation;
		this.statuses.clear();
		this.releaseRetirementListener = sandbox.session.beforeContainerRetirement?.(async () => {
			await this.stop();
			this.epoch++;
			this.changed();
		});
		this.epoch++;
	}
	private resolveManagedRoute(route: LspRoute): LspRoute {
		const tool = this.sandbox?.session.environment.toolInventory?.tools.find(
			(entry) => entry.id === route.preset,
		);
		const privateToolsRoot = resolve(this.agentDir, "extensions", "code-quality", "tools", route.preset);
		const managedCommand =
			route.command.startsWith("/opt/pi-quality-tools/") || route.command.startsWith("/opt/pi-tools/") ||
			route.command.startsWith(`${privateToolsRoot}/`);
		if (!tool || !managedCommand || route.preset === "custom") {
			return route;
		}
		return { ...route, command: tool.executable, version: tool.version };
	}

	private async client(route: LspRoute, signal?: AbortSignal): Promise<SandboxLspClient> {
		signal?.throwIfAborted();
		const sandbox = this.sandbox;
		if (!sandbox) {
			throw new Error("LSP sandbox is unavailable");
		}
		const key = `${sandbox.session.environment.container}:${sandbox.session.generation}:${digest(JSON.stringify(route))}`;
		const existing = this.clients.get(key);
		if (existing) {
			return existing;
		}
		const pending = this.pendingClients.get(key);
		if (pending) {
			return this.waitForClientLaunch(pending, signal);
		}
		const owner = this.clientLifetime;
		const controller = new AbortController();
		const launchSignal = AbortSignal.any([owner.signal, controller.signal]);
		const generation = sandbox.session.generation;
		const assertOwner = () => {
			launchSignal.throwIfAborted();
			if (this.sandbox !== sandbox || generation !== sandbox.session.generation) {
				throw new Error("LSP client belongs to a retired container");
			}
		};
		const launch: PendingClientLaunch = {
			controller,
			waiters: 0,
			promise: Promise.resolve().then(() => this.launchClient(route, sandbox, key, launchSignal, generation, assertOwner)),
		};
		this.pendingClients.set(key, launch);
		void launch.promise.finally(() => {
			if (this.pendingClients.get(key) === launch) {
				this.pendingClients.delete(key);
			}
		}).catch(() => {});
		return this.waitForClientLaunch(launch, signal);
	}
	private async waitForClientLaunch(launch: PendingClientLaunch, signal?: AbortSignal): Promise<SandboxLspClient> {
		launch.waiters++;
		let abort: (() => void) | undefined;
		try {
			if (!signal) {
				return await launch.promise;
			}
			return await new Promise<SandboxLspClient>((resolve, reject) => {
				abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
				launch.promise.then(resolve, reject);
				if (signal.aborted) {
					abort();
				}
			});
		} finally {
			if (abort) {
				signal?.removeEventListener("abort", abort);
			}
			launch.waiters--;
			if (signal?.aborted && launch.waiters === 0) {
				launch.controller.abort(signal.reason);
			}
		}
	}
	private async launchClient(
		route: LspRoute,
		sandbox: QualitySandbox,
		key: string,
		launchSignal: AbortSignal,
		generation: number,
		assertOwner: () => void,
	): Promise<SandboxLspClient> {
		const root = await this.routeRoot(route, launchSignal);
		assertOwner();
		const client = new SandboxLspClient(
			sandbox,
			route,
			root,
			(phase, reason) => {
				if (launchSignal.aborted || generation !== sandbox.session.generation) {
					return;
				}
				this.statuses.set(route.id, {
					id: route.id,
					name: route.preset,
					root: route.root,
					phase,
					clients: 1,
					...(reason ? { reason } : {}),
				});
				this.changed();
			},
			() => {
				if (!launchSignal.aborted) {
					this.epoch++;
					this.changed();
				}
			},
			launchSignal,
		);
		try {
			await client.start();
			assertOwner();
		} catch (error) {
			await client.stop();
			if (launchSignal.aborted) {
				throw error;
			}
			this.statuses.set(route.id, {
				id: route.id,
				name: route.preset,
				root: route.root,
				phase: "failed",
				clients: 0,
				reason: String(error),
			});
			this.changed();
			throw error;
		}
		this.clients.set(key, client);
		this.statuses.set(route.id, {
			id: route.id,
			name: route.preset,
			root: route.root,
			phase: "ready",
			clients: 1,
		});
		this.changed();
		return client;
	}
	private async routeRoot(route: LspRoute, signal?: AbortSignal): Promise<string> {
		const sandbox = this.sandbox!;
		if (route.root.startsWith("/")) {
			return sandbox.session.filesystem.canonical(route.root, signal);
		}
		const root = this.project
			? await guestLspProjectRoot(sandbox, this.project.root)
			: sandbox.session.environment.workspace;
		return sandbox.session.filesystem.canonical(resolve(root, route.root), signal);
	}
	async check(
		files: { path: string; after: string | null }[],
		signal: AbortSignal,
		onStart?: () => void,
	): Promise<LspCheckResult | undefined> {
		const sandbox = this.sandbox;
		this.trusted = this.currentTrust?.() ?? this.trusted;
		if (!this.trusted) {
			await this.stop();
			return undefined;
		}
		if (this.project) {
			const currentProfile = await loadLspProfile(this.agentDir, this.project);
			if (currentProfile?.revision !== this.profile?.revision) {
				await this.stop();
				this.profile = currentProfile;
				this.epoch++;
			}
		}
		if (
			!this.automaticChecksEnabled ||
			!this.trusted ||
			!sandbox ||
			this.profile?.profile.enabled === false
		) {
			return undefined;
		}
		if (sandbox.session.generation !== this.containerGeneration) {
			await this.stop();
			this.containerGeneration = sandbox.session.generation;
			this.epoch++;
		}
		let routes = (this.profile?.profile.routes ?? []).map((route) => this.resolveManagedRoute(route));
		const automatic = !this.profile || this.profile.profile.mode === "auto";
		const explicitRoutesWithRoots = await Promise.all(routes.map(async (route) => ({
			route, root: await this.routeRoot(route, signal),
		})));
		const filesNeedingAutomaticRoutes = automatic ? files.filter((file) => {
			const hasExplicitRoute = explicitRoutesWithRoots.some(({ route, root }) =>
				routeMatchesFile(route, root, file.path),
			);
			const hasEnabledPreset = LSP_PRESETS.some((preset) =>
				!this.profile?.profile.disabledLanguages?.includes(preset.id) &&
				Object.keys(preset.extensions).some((extension) => file.path.endsWith(extension)),
			);
			return file.after !== null && !hasExplicitRoute && hasEnabledPreset;
		}) : [];
		if (filesNeedingAutomaticRoutes.length > 0) {
			const inventory = sandbox.session.environment.toolInventory;
			if (!inventory) {
				return {
					kind: "unavailable",
					reason: "Sandbox tooling inventory is unavailable; provision the global toolset",
				};
			}
			const discovery = await discoverSandboxLspFiles(sandbox, signal);
			const discoveryRevision = digest(
				JSON.stringify([discovery.manifestRevision, inventory.revision, this.profile?.revision, sandbox.session.generation]),
			);
			if (this.discoveryRevision !== discoveryRevision) {
				await this.stop();
				this.automaticRoutes.clear();
				this.discoveryRevision = discoveryRevision;
				this.epoch++;
			}
			const previousRoutes = JSON.stringify([...this.automaticRoutes.values()]);
			const inferredRoutes = new Map(this.automaticRoutes);
			for (const file of filesNeedingAutomaticRoutes) {
				const workspace = sandbox.session.environment.workspace;
				const insideWorkspace = file.path.startsWith(`${workspace}/`);
				const discoveryRoot = insideWorkspace ? workspace : dirname(file.path);
				const relativePath = relative(discoveryRoot, file.path);
				const fileDiscovery = insideWorkspace
					? discovery
					: await discoverSandboxLspFiles(sandbox, signal, discoveryRoot);
				const inferred = automaticLspRoute({
					file: relativePath,
					files: fileDiscovery.files,
					tools: inventory.tools,
					truncated: fileDiscovery.truncated,
				});
				if (inferred.kind === "unavailable") {
					return inferred;
				}
				if (
					inferred.kind === "route" &&
					!this.profile?.profile.disabledLanguages?.includes(inferred.route.preset)
				) {
					if (inferred.route.preset === "rust-analyzer") {
						const rustTool = inventory.tools.find((tool) => tool.id === "rust-runtime");
						const cargo = rustTool ? `${dirname(rustTool.executable)}/cargo` : "cargo";
						const located = await locateCargoWorkspaceManifest(sandbox, dirname(file.path), cargo, signal);
						if (located.code !== 0) {
							return { kind: "unavailable", reason: `Cannot locate Cargo workspace: ${located.stderr}` };
						}
						const manifest = located.output.toString().trim();
						if (!manifest.endsWith("/Cargo.toml")) {
							return { kind: "unavailable", reason: "Cargo returned an invalid workspace manifest path" };
						}
						inferred.route.root = dirname(await sandbox.session.filesystem.canonical(manifest, signal));
						inferred.route.id = `auto-rust-${digest(inferred.route.root).slice(0, 16)}`;
					}
					inferred.route.root = resolve(discoveryRoot, inferred.route.root);
					if (!insideWorkspace) {
						inferred.route.id = `${inferred.route.preset}-external-${digest(discoveryRoot).slice(0, 16)}`;
					}
					inferredRoutes.set(inferred.route.id, inferred.route);
				}
			}
			this.automaticRoutes = inferredRoutes;
			if (JSON.stringify([...inferredRoutes.values()]) !== previousRoutes) {
				this.epoch++;
			}
			routes = [...routes, ...inferredRoutes.values()];
		}
		onStart?.();
		const findings = [];
		const hashes: Record<string, string> = {};
		const startedAt = Date.now();
		const checkedWorkspaceRevision = this.epoch;
		try {
			for (const file of files) {
				if (file.after === null) {
					continue;
				}
				const routesWithRoots = await Promise.all(routes.map(async (route) => ({ route, root: await this.routeRoot(route, signal) })));
				const matchingRoutes = routesWithRoots.filter(({ route, root }) => routeMatchesFile(route, root, file.path));
				const deepestRootDepth = Math.max(-1, ...matchingRoutes.map(({ root }) => root.split("/").length));
				for (const { route, root: routeRoot } of matchingRoutes.filter(({ root }) => root.split("/").length === deepestRootDepth)) {
					const language = Object.entries(route.extensions).find(([extension]) =>
						file.path.endsWith(extension),
					)?.[1];
					if (!language) {
						continue;
					}
					if (file.path !== routeRoot && !file.path.startsWith(`${routeRoot}/`)) {
						continue;
					}
					const current = (await sandbox.session.filesystem.read(file.path, signal)).toString();
					if (current !== file.after) {
						return { kind: "stale", reason: "Guest source changed before LSP check" };
					}
					const client = await this.client(route, signal);
					findings.push(...(await client.check(file.path, language, current, signal)));
					const afterCheck = (await sandbox.session.filesystem.read(file.path, signal)).toString();
					if (afterCheck !== current || sandbox.session.generation !== this.containerGeneration) {
						return { kind: "stale", reason: "Guest workspace changed during LSP diagnostics" };
					}
					hashes[file.path] = digest(current);
				}
			}
			if (!Object.keys(hashes).length) {
				return undefined;
			}
			if (this.epoch !== checkedWorkspaceRevision) {
				return { kind: "stale", reason: "LSP dependencies changed during the diagnostic batch" };
			}
			return {
				kind: "checked",
				findings,
				hashes,
				generation: `${this.containerGeneration}:${randomUUID()}`,
				workspaceRevision: this.epoch,
				elapsedMs: Date.now() - startedAt,
			};
		} catch (error) {
			return {
				kind: "unavailable",
				reason: `Container LSP unavailable: ${String(error)}. Install/validate Linux tools inside the devcontainer.`,
			};
		}
	}
	async validate(route: LspRoute, project: LspProject, signal: AbortSignal) {
		signal.throwIfAborted();
		try {
			await this.attachSandbox();
			signal.throwIfAborted();
			this.project = project;
			const effectiveRoute = this.resolveManagedRoute(route);
			const root = await this.routeRoot(effectiveRoute, signal);
			const discovery = await discoverSandboxLspFiles(this.sandbox!, signal, root);
			let matchedSource: string | undefined;
			let matchedLanguage: string | undefined;
			for (const source of discovery.files) {
				const routeEntry = Object.entries(effectiveRoute.extensions).find(([extension]) => source.endsWith(extension));
				if (routeEntry) {
					matchedSource = source;
					matchedLanguage = routeEntry[1];
					break;
				}
			}
			if (!matchedSource || !matchedLanguage) {
				return { ready: false, summary: "No representative source file for diagnostic validation" };
			}
			const path = resolve(root, matchedSource);
			const text = (await this.sandbox!.session.filesystem.read(path, signal)).toString();
			const language = matchedLanguage;
			const client = await this.client(effectiveRoute, signal);
			signal.throwIfAborted();
			await client.check(path, language, text, signal);
			if ((await this.sandbox!.session.filesystem.read(path, signal)).toString() !== text) {
				return { ready: false, summary: "Source changed during diagnostic validation" };
			}
			return { ready: true, summary: "Language server returned complete project diagnostics inside Podman" };
		} catch (error) {
			return { ready: false, summary: String(error) };
		}
	}
	effectiveRoutes(): LspRoute[] {
		return [
			...(this.profile?.profile.routes ?? []).map((route) => this.resolveManagedRoute(route)),
			...this.automaticRoutes.values(),
		];
	}

	async refreshWorkspace(signal: AbortSignal): Promise<void> {
		const owner = this.clientLifetime;
		const signalWithOwner = AbortSignal.any([signal, owner.signal]);
		signalWithOwner.throwIfAborted();
		await Promise.all([...this.clients.values()].map((client) => client.refreshWorkspace(signalWithOwner)));
		signalWithOwner.throwIfAborted();
	}

	async restart(_id: string | undefined, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		await this.stop();
		this.epoch++;
	}
	async stop(): Promise<void> {
		const lifetime = this.clientLifetime;
		lifetime.abort();
		await Promise.allSettled([...this.pendingClients.values()].map((launch) => launch.promise));
		await Promise.allSettled([...this.clients.values()].map((client) => client.stop()));
		this.clients.clear();
		this.pendingClients.clear();
		if (this.clientLifetime === lifetime) {
			this.clientLifetime = new AbortController();
		}
	}
	statusText(): string {
		if (!this.profile && !this.statuses.size) {
			return this.automaticChecksEnabled
				? "LSP automatic — servers start when relevant files are checked"
				: "LSP suspended because quality is off";
		}
		if (this.profile && !this.profile.profile.enabled) {
			return "LSP checking disabled";
		}
		if (this.profile?.profile.enabled && !this.automaticChecksEnabled) {
			return (
				"LSP profile enabled; automatic checks suspended because quality is off. Run /quality on.\n" +
				this.profile.profile.routes.map((route) => `${route.id}: configured (Podman)`).join("\n")
			);
		}
		return (
			this.header
				.map(
					(server) => `${server.id}: ${server.phase} (Podman)${server.reason ? ` — ${server.reason}` : ""}`,
				)
				.join("\n") || "LSP automatic — no active servers"
		);
	}
}
