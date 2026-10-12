import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { LspClient } from "./lsp-client.js";
import { presetById, presetRoute } from "./lsp-presets.js";

const processes = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...(await original()), spawn: processes.spawn }));
afterEach(() => {
	vi.restoreAllMocks();
	processes.spawn.mockReset();
});

it.each(["close", "close then write error", "write error"])(
	"routes connection %s during an outstanding request to status without console output",
	async (failure) => {
		const guard = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			connected: true,
			exitCode: null,
			signalCode: null,
			send: vi.fn(() => queueMicrotask(() => guard.emit("close", 0, null))),
			kill: vi.fn(),
		});
		processes.spawn.mockReturnValue(guard as unknown as ChildProcess);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const route = presetRoute(presetById("pyright"), "/fixture/server");
		route.startupTimeoutMs = 1000;
		const status = vi.fn();
		const client = new LspClient(route, "/workspace", status, vi.fn());
		const starting = client.start();
		const reason = failure === "write error" ? "write EPIPE" : "Language server connection closed";
		const failedStartup = expect(starting).rejects.toThrow(reason);
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (failure !== "write error") {
			guard.stdout.destroy();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		if (failure !== "close") {
			guard.stdin.emit("error", new Error("write EPIPE"));
		}
		await failedStartup;
		await client.stop();
		expect(status).toHaveBeenCalledWith("failed", reason);
		expect(consoleError).not.toHaveBeenCalled();
	},
);

it("does not log connection errors when stop closes a pending shutdown request", async () => {
	const guard = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		connected: true,
		exitCode: null,
		signalCode: null,
		send: vi.fn(() => queueMicrotask(() => guard.emit("close", 0, null))),
		kill: vi.fn(),
	});
	processes.spawn.mockReturnValue(guard as unknown as ChildProcess);
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	const route = presetRoute(presetById("pyright"), "/fixture/server");
	const status = vi.fn();
	const client = new LspClient(route, "/workspace", status, vi.fn());
	const starting = client.start();
	await new Promise<void>((resolve) => setImmediate(resolve));
	const initialized = JSON.stringify({
		jsonrpc: "2.0",
		id: 0,
		result: {
			capabilities: { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } },
		},
	});
	guard.stdout.write(`Content-Length: ${Buffer.byteLength(initialized)}\r\n\r\n${initialized}`);
	await starting;
	const stopping = client.stop();
	guard.stdout.destroy();
	await stopping;
	expect(consoleError).not.toHaveBeenCalled();
	expect(status).toHaveBeenCalledWith("stopped");
});
