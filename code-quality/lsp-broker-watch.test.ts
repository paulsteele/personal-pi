import { createServer, type Server } from "node:net";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BrokerConnection } from "./lsp-broker-registry.js";
import { runLspBroker } from "./lsp-broker.js";
import type { BrokerLaunch } from "./lsp-broker-protocol.js";
import { presetById, presetRoute } from "./lsp-presets.js";

const watching = vi.hoisted(() => ({ start: vi.fn() }));
const languageServer = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), synchronize: vi.fn() }));
vi.mock("./lsp-workspace-watch.js", () => ({ watchLspWorkspace: watching.start }));
vi.mock("./lsp-client.js", () => ({
	LspClient: class {
		constructor(
			_route: unknown,
			_root: unknown,
			readonly status: (phase: string) => void,
		) {}
		async start() {
			await languageServer.start();
			this.status("ready");
		}
		stop = languageServer.stop;
		synchronize = languageServer.synchronize;
	},
}));
const servers: Server[] = [];
function trackServer(server: Server): Server {
	servers.push(server);
	return server;
}
vi.mock("node:net", async (original) => {
	const net = await original<typeof import("node:net")>();
	return {
		...net,
		createServer: (...args: Parameters<typeof createServer>) => trackServer(net.createServer(...args)),
	};
});

const directories: string[] = [];
const connections: BrokerConnection[] = [];
afterEach(async () => {
	await Promise.all(connections.splice(0).map((connection) => connection.close()));
	for (const server of servers.splice(0)) {
		if (server.listening) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}
	vi.restoreAllMocks();
	vi.resetAllMocks();
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function brokerFixture() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "broker-watch-")));
	directories.push(directory);
	const root = join(directory, "project");
	await mkdir(root);
	const launch: BrokerLaunch = {
		version: 1,
		key: "test-key",
		generation: "test-generation",
		token: "test-token",
		socket: join(directory, "broker.sock"),
		directory,
		root,
		route: presetRoute(presetById("roslyn"), "/unused/roslyn"),
	};
	const originalOn = process.on.bind(process);
	const ignoredSignals = new Set<string | symbol>(["SIGTERM", "SIGHUP"]);
	vi.spyOn(process, "on").mockImplementation((event, listener) => {
		if (ignoredSignals.has(event)) {
			return process;
		}
		return originalOn(event, listener);
	});
	vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
	if (typeof process.disconnect === "function") {
		vi.spyOn(process, "disconnect").mockImplementation(() => {});
	}
	if (typeof process.send === "function") {
		vi.spyOn(process, "send").mockImplementation(() => true);
	}
	const update = vi.fn();
	await runLspBroker(launch);
	const connection = await BrokerConnection.connect({ ...launch, pid: process.pid }, "test-client", update);
	connections.push(connection);
	const watcherFailed = watching.start.mock.calls[0]![2] as (error: Error) => void;
	const requests = [{ path: join(root, "App.cs"), hash: "0".repeat(64), languageId: "csharp" }];
	return { connection, watcherFailed, requests, root, update };
}

it("keeps the socket alive and refuses checks when the workspace watcher fails after startup", async () => {
	watching.start.mockReturnValue({ ready: Promise.resolve(), close: vi.fn().mockResolvedValue(undefined) });
	const fixture = await brokerFixture();
	fixture.watcherFailed(new Error("EMFILE: too many open files, watch"));
	const expectedReason = `Workspace watcher failed for ${fixture.root}: EMFILE: too many open files, watch; reload all attached Pi sessions to recreate the broker`;
	expect(await fixture.connection.check(fixture.requests, AbortSignal.timeout(2000))).toEqual({
		kind: "unavailable",
		reason: expectedReason,
	});
	expect(fixture.connection.status).toMatchObject({ phase: "failed", reason: expectedReason });
	await expect(fixture.connection.restart(AbortSignal.timeout(2000))).rejects.toThrow(expectedReason);
	expect(languageServer.synchronize).not.toHaveBeenCalled();
	await fixture.connection.close();
	await new Promise((resolve) => setTimeout(resolve, 50));
});

it("preserves a watcher startup failure even after the language server announces readiness", async () => {
	let finishServerStartup!: () => void;
	languageServer.start.mockReturnValue(
		new Promise<void>((resolve) => {
			finishServerStartup = resolve;
		}),
	);
	watching.start.mockImplementation((_root, _changed, failed) => {
		const error = new Error("ENOSPC: watcher limit reached");
		failed(error);
		const ready = Promise.reject(error);
		void ready.catch(() => {});
		return { ready, close: vi.fn().mockResolvedValue(undefined) };
	});
	const fixture = await brokerFixture();
	finishServerStartup();
	expect(await fixture.connection.check(fixture.requests, AbortSignal.timeout(2000))).toMatchObject({
		kind: "unavailable",
		reason: expect.stringContaining("ENOSPC: watcher limit reached"),
	});
	expect(fixture.connection.status).toMatchObject({
		phase: "failed",
		reason: expect.stringContaining("ENOSPC: watcher limit reached"),
	});
	expect(languageServer.synchronize).not.toHaveBeenCalled();
	await fixture.connection.close();
	await new Promise((resolve) => setTimeout(resolve, 50));
});
