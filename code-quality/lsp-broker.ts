import { createServer, type Socket } from "node:net";
import { chmod, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { LspClient } from "./lsp-client.js";
import { canonicalPath, inside } from "./capture.js";
import { digest } from "./proposal.js";
import { watchLspWorkspace } from "./lsp-workspace-watch.js";
import {
	parseBrokerRequest,
	type BrokerLaunch,
	type BrokerReply,
	type BrokerRequest,
} from "./lsp-broker-protocol.js";
import type { LspCheckResult, LspServerStatus } from "./lsp-diagnostics.js";

export async function runLspBroker(launch: BrokerLaunch): Promise<void> {
	const leases = new Map<Socket, string>();
	const checkingClients = new Set<string>();
	const pending = new Map<string, AbortController>();
	let workspaceRevision = 0;
	let retiring = false;
	let watcherFailure: string | undefined;
	let generation = launch.generation;
	let state: LspServerStatus = {
		id: launch.route.id,
		name: launch.route.preset,
		root: launch.root,
		phase: "starting",
		clients: 0,
		generation,
		workspaceRevision,
	};
	const send = (socket: Socket, reply: BrokerReply) => {
		if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
	};
	const broadcast = (event: "status" | "invalidated") => {
		state = { ...state, clients: leases.size, workspaceRevision, generation };
		for (const [socket, clientId] of leases) {
			const hasPendingCheck = [...pending.keys()].some((key) => key.startsWith(`${clientId}:`));
			const queued = hasPendingCheck && !checkingClients.has(clientId);
			send(socket, { event, status: { ...state, queued } });
		}
	};
	const makeClient = () =>
		new LspClient(
			launch.route,
			launch.root,
			(phase, reason) => {
				state = { ...state, phase: watcherFailure ? "failed" : phase, reason: watcherFailure ?? reason };
				broadcast("status");
			},
			() => {
				if (state.phase === "ready") {
					workspaceRevision++;
					broadcast("invalidated");
				}
			},
			join(launch.directory, "guard.json"),
		);
	let client: LspClient;
	let ready: Promise<void[]>;
	const startClient = () => {
		client = makeClient();
		ready = Promise.all([client.start(), watcher.ready]).catch((error) => {
			state = { ...state, phase: "failed", reason: watcherFailure ?? String(error) };
			broadcast("status");
			throw error;
		});
		ready.catch(() => {});
	};
	let restarting: Promise<void> | undefined;
	const checks = new Map<
		string,
		{ controller: AbortController; waiters: Set<string>; result: Promise<LspCheckResult> }
	>();
	let queue: Promise<unknown> = Promise.resolve();
	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = queue.then(operation);
		queue = result.catch(() => {});
		return result;
	};
	const watcher = watchLspWorkspace(
		launch.root,
		(path, changeKind) => {
			if (retiring || watcherFailure) {
				return;
			}
			workspaceRevision++;
			broadcast("invalidated");
			void enqueue(async () => {
				await ready;
				await client.fileChanged(path, changeKind);
			}).catch((error) => {
				state = { ...state, phase: "failed", reason: watcherFailure ?? String(error) };
				broadcast("status");
			});
		},
		(error) => {
			if (retiring || watcherFailure) {
				return;
			}
			watcherFailure = `Workspace watcher failed for ${launch.root}: ${error.message}; close every Pi session attached to this workspace before reopening any of them to recreate the broker`;
			workspaceRevision++;
			state = { ...state, phase: "failed", reason: watcherFailure };
			broadcast("invalidated");
		},
	);

	const server = createServer((socket) => {
		let bytes = 0;
		const lines = createInterface({ input: socket, crlfDelay: Infinity });
		lines.on("error", () => socket.destroy());
		socket.on("error", () => {});
		socket.on("data", (chunk) => {
			bytes += chunk.length;
			if (bytes > 2 * 1024 * 1024) socket.destroy();
			const lastNewline = chunk.lastIndexOf(10);
			if (lastNewline >= 0) bytes = chunk.length - lastNewline - 1;
		});
		lines.on("line", (line) => {
			if (Buffer.byteLength(line) > 2 * 1024 * 1024) {
				socket.destroy();
				return;
			}
			void handle(socket, line).catch((error) => {
				let id: string | undefined;
				try {
					id = JSON.parse(line).id;
				} catch {}
				send(socket, { id, error: String(error) });
			});
		});
		socket.once("close", () => {
			lines.close();
			const id = leases.get(socket);
			leases.delete(socket);
			if (id) for (const [key, controller] of pending) if (key.startsWith(`${id}:`)) controller.abort();
			broadcast("status");
			if (id && leases.size === 0) void retire();
		});
	});

	async function check(request: BrokerRequest, signal: AbortSignal): Promise<LspCheckResult> {
		const startedAt = performance.now();
		if (signal.aborted) return { kind: "cancelled", reason: "Client cancelled the check" };
		checkingClients.add(request.clientId);
		try {
			await ready;
			if (watcherFailure) {
				return { kind: "unavailable", reason: watcherFailure };
			}
			const hashes: Record<string, string> = {};
			for (const file of request.files!) {
				const path = canonicalPath(file.path);
				if (path !== file.path || !inside(launch.root, path))
					throw new Error("File is outside broker workspace");
				const language = Object.entries(launch.route.extensions).find(([extension]) =>
					path.endsWith(extension),
				)?.[1];
				if (language !== file.languageId) throw new Error("File language does not match configured route");
				const text = await readFile(path, "utf8");
				if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("LSP file exceeds 1 MiB");
				if (digest(text) !== file.hash)
					return { kind: "stale", reason: "File changed before broker synchronization" };
				hashes[path] = file.hash;
				await client.synchronize(path, language, text);
			}
			if (watcherFailure) {
				return { kind: "unavailable", reason: watcherFailure };
			}
			const revision = workspaceRevision;
			state = { ...state, phase: "checking" };
			broadcast("status");
			const findings = [];
			for (const file of request.files!) {
				signal.throwIfAborted();
				findings.push(...(await client.diagnose(file.path, file.languageId, signal)));
			}
			for (const [path, hash] of Object.entries(hashes))
				if (digest(await readFile(path, "utf8")) !== hash)
					return { kind: "stale", reason: "File changed while diagnostics were running" };
			if (watcherFailure) {
				return { kind: "unavailable", reason: watcherFailure };
			}
			if (revision !== workspaceRevision) {
				return { kind: "stale", reason: "Workspace changed during diagnostics" };
			}
			if (JSON.stringify(findings).length > 1024 * 1024) throw new Error("Complete diagnostics exceed 1 MiB");
			return {
				kind: "checked",
				findings,
				hashes,
				generation,
				workspaceRevision: revision,
				elapsedMs: performance.now() - startedAt,
			};
		} catch (error) {
			return signal.aborted
				? { kind: "cancelled", reason: "Client cancelled the check" }
				: { kind: "unavailable", reason: watcherFailure ?? String(error) };
		} finally {
			checkingClients.delete(request.clientId);
			if (!retiring && !watcherFailure && state.phase === "checking") {
				state = { ...state, phase: "ready" };
				broadcast("status");
			}
		}
	}

	async function handle(socket: Socket, line: string): Promise<void> {
		let request: BrokerRequest;
		try {
			request = parseBrokerRequest(JSON.parse(line));
		} catch {
			socket.destroy();
			return;
		}
		if (request.token !== launch.token || retiring) {
			send(socket, { id: request.id, error: "Broker unavailable or authentication failed" });
			return;
		}
		if (request.method === "attach") {
			if (leases.has(socket) && leases.get(socket) !== request.clientId) {
				send(socket, { id: request.id, error: "Connection already belongs to another client" });
				return;
			}
			if ([...leases.entries()].some(([other, id]) => other !== socket && id === request.clientId)) {
				send(socket, { id: request.id, error: "Client identity already attached" });
				return;
			}
			leases.set(socket, request.clientId);
			broadcast("status");
			send(socket, { id: request.id, result: state });
			return;
		}
		if (leases.get(socket) !== request.clientId) {
			send(socket, { id: request.id, error: "Attach before using this broker" });
			return;
		}
		if (request.method === "status") {
			send(socket, { id: request.id, result: state });
			return;
		}
		if (request.method === "cancel") {
			pending.get(`${request.clientId}:${request.requestId}`)?.abort();
			send(socket, { id: request.id, result: state });
			return;
		}
		if (request.method === "detach") {
			leases.delete(socket);
			for (const [key, controller] of pending) if (key.startsWith(`${request.clientId}:`)) controller.abort();
			broadcast("status");
			if (leases.size === 0) await retire();
			send(socket, { id: request.id, result: state });
			socket.end();
			return;
		}
		if (request.method === "restart") {
			if (watcherFailure) {
				throw new Error(watcherFailure);
			}
			if (!restarting) {
				for (const controller of pending.values()) controller.abort();
				restarting = enqueue(async () => {
					await client.stop();
					generation = `${launch.generation}:${Date.now()}`;
					workspaceRevision++;
					startClient();
					broadcast("invalidated");
					await ready;
				}).finally(() => {
					restarting = undefined;
				});
			}
			await restarting;
			send(socket, { id: request.id, result: state });
			return;
		}
		const controller = new AbortController();
		const key = `${request.clientId}:${request.id}`;
		pending.set(key, controller);
		broadcast("status");
		const filesInPathOrder = [...request.files!].sort((left, right) => left.path.localeCompare(right.path));
		const checkKey = JSON.stringify([generation, workspaceRevision, filesInPathOrder]);
		let shared = checks.get(checkKey);
		if (!shared) {
			const sharedController = new AbortController();
			shared = {
				controller: sharedController,
				waiters: new Set(),
				result: enqueue(() => check(request, sharedController.signal)),
			};
			checks.set(checkKey, shared);
			void shared.result.finally(() => checks.delete(checkKey)).catch(() => {});
		}
		shared.waiters.add(key);
		const releaseCheckWaiter = () => {
			shared.waiters.delete(key);
			if (!shared.waiters.size) shared.controller.abort();
		};
		controller.signal.addEventListener("abort", releaseCheckWaiter, { once: true });
		try {
			const result = await shared.result;
			send(socket, {
				id: request.id,
				result: controller.signal.aborted
					? { kind: "cancelled", reason: "Client cancelled the check" }
					: result,
			});
		} finally {
			controller.signal.removeEventListener("abort", releaseCheckWaiter);
			releaseCheckWaiter();
			pending.delete(key);
			broadcast("status");
		}
	}

	async function retire(): Promise<void> {
		if (retiring) return;
		retiring = true;
		for (const controller of pending.values()) controller.abort();
		server.close();
		await watcher.close();
		await client?.stop();
		await unlink(launch.socket).catch(() => {});
		const registryPath = join(dirname(launch.directory), "registry.json");
		try {
			const registry = JSON.parse(await readFile(registryPath, "utf8")) as { generation?: string };
			if (registry.generation === launch.generation) await unlink(registryPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				process.stderr.write(`Cannot retire broker registry: ${String(error)}\n`);
		}
		setTimeout(() => process.exit(0), 30);
	}
	process.on("SIGTERM", () => {
		void retire();
	});
	process.on("SIGHUP", () => {
		void retire();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(launch.socket, () => resolve());
	});
	await chmod(launch.socket, 0o600);
	startClient();
	process.send?.({ kind: "listening" });
	process.disconnect?.();
	const initialAttachDeadline = setTimeout(() => {
		if (!leases.size) void retire();
	}, 15000);
	initialAttachDeadline.unref();
}
