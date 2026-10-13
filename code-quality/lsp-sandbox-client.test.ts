import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SandboxLspClient } from "./lsp-sandbox-client.js";
import { presetById, presetRoute } from "./lsp-presets.js";
import type { QualitySandbox } from "./sandbox.js";

const constructClient = vi.hoisted(() => vi.fn());
const lsp = vi.hoisted(() => ({
	start: vi.fn(async () => {}),
	stop: vi.fn(async () => {}),
	fileChanged: vi.fn(async () => {}),
	synchronize: vi.fn(async () => {}),
	diagnose: vi.fn(async () => []),
}));
vi.mock("./lsp-client.js", () => ({
	LspClient: class {
		constructor(...args: unknown[]) {
			constructClient(...args);
		}
		start = lsp.start;
		stop = lsp.stop;
		fileChanged = lsp.fileChanged;
		synchronize = lsp.synchronize;
		diagnose = lsp.diagnose;
	},
}));
beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => {
	vi.useRealTimers();
});

function sandboxFixture() {
	const contents = new Map<string, string>();
	const sandbox: QualitySandbox = {
		sessionId: "session",
		revision: () => "revision",
		session: {
			generation: 1,
			processSupervisor: "process-supervisor-script",
			environment: { container: "container", user: "root", workspace: "/workspace", configuration: {} },
			filesystem: {
				canonical: async (path) => path,
				read: async (path) => Buffer.from(contents.get(path) ?? ""),
				write: async () => {},
				mkdir: async () => {},
				stat: async () => ({ file: true, directory: false, size: 0 }),
				list: async () => [],
			},
			execute: async () => ({ output: Buffer.alloc(0), stderr: "", code: 0 }),
		},
	};
	const route = presetRoute(presetById("pyright"), "/opt/pyright-langserver");
	return { contents, sandbox, route };
}

it("uses supervisor-owned lifetime rather than a host PID for container language servers", () => {
	const { sandbox, route } = sandboxFixture();
	new SandboxLspClient(sandbox, route, "/workspace");
	expect(constructClient).toHaveBeenCalledWith(
		route,
		"/workspace",
		expect.any(Function),
		expect.any(Function),
		undefined,
		expect.objectContaining({
			command: "podman",
			clientProcessId: null,
			args: [
				"exec",
				"-i",
				"--user",
				"root",
				"--workdir",
				"/workspace",
				"container",
				"python3",
				"-u",
				"-c",
				"process-supervisor-script",
				expect.stringContaining("/tmp/pi-sandbox-processes/lsp-"),
				"/opt/pyright-langserver",
				"--stdio",
			],
		}),
	);
});

it("launches a mounted catalog server inside the project container at its inventory path", () => {
	const { sandbox, route } = sandboxFixture();
	const mountedServerPath = "/opt/pi-tools/pyright/1.1.414/bin/pyright-langserver";
	const mountedRoute = { ...route, command: mountedServerPath };
	new SandboxLspClient(sandbox, mountedRoute, "/workspace");
	const launch = constructClient.mock.calls[0]![5] as { command: string; args: string[] };
	expect(launch.command).toBe("podman");
	expect(launch.args).toContain("container");
	expect(launch.args).toContain(mountedServerPath);
	expect(launch.args).not.toContain("--mount");
});

it("refreshes previously opened guest documents without another quality batch", async () => {
	vi.useFakeTimers();
	const { contents, sandbox, route } = sandboxFixture();
	contents.set("/workspace/dependency.py", "before");
	const refresh = vi.fn();
	const client = new SandboxLspClient(sandbox, route, "/workspace", undefined, refresh);
	try {
		await client.start();
		await client.check("/workspace/dependency.py", "python", "before", new AbortController().signal);
		contents.set("/workspace/dependency.py", "after");
		await vi.advanceTimersByTimeAsync(1000);
		expect(lsp.fileChanged).toHaveBeenCalledWith("/workspace/dependency.py", 2);
		expect(refresh).toHaveBeenCalledOnce();
	} finally {
		await client.stop();
	}
	contents.set("/workspace/dependency.py", "after retirement");
	await vi.advanceTimersByTimeAsync(2000);
	expect(lsp.fileChanged).toHaveBeenCalledOnce();
});

it("refreshes changed dependencies at an explicit acceptance boundary without waiting for polling", async () => {
	vi.useFakeTimers();
	const { contents, sandbox, route } = sandboxFixture();
	contents.set("/workspace/dependency.py", "before");
	const refresh = vi.fn();
	const client = new SandboxLspClient(sandbox, route, "/workspace", undefined, refresh);
	try {
		await client.start();
		await client.check("/workspace/dependency.py", "python", "before", new AbortController().signal);
		contents.set("/workspace/dependency.py", "after");
		await client.refreshWorkspace(new AbortController().signal);
		expect(lsp.fileChanged).toHaveBeenCalledWith("/workspace/dependency.py", 2);
		expect(refresh).toHaveBeenCalledOnce();
	} finally {
		await client.stop();
	}
});

it("still stops the protocol client when its guest termination request times out", async () => {
	vi.useFakeTimers();
	const { sandbox, route } = sandboxFixture();
	const execute = vi.fn(
		async (options: { timeoutMs?: number; signal?: AbortSignal }) =>
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error("Guest process timed out")), options.timeoutMs);
			}),
	);
	sandbox.session.execute = execute;
	const client = new SandboxLspClient(sandbox, route, "/workspace");
	const stopping = client.stop();
	expect(execute).toHaveBeenCalledWith(
		expect.objectContaining({ timeoutMs: 5000, signal: expect.any(AbortSignal) }),
	);
	expect(lsp.stop).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(5000);
	await stopping;
	expect(lsp.stop).toHaveBeenCalledOnce();
}, 10000);

it("rejects diagnostics if a dependency changes while the polling refresh runs", async () => {
	vi.useFakeTimers();
	const { contents, sandbox, route } = sandboxFixture();
	contents.set("/workspace/dependency.py", "before");
	contents.set("/workspace/main.py", "main");
	const client = new SandboxLspClient(sandbox, route, "/workspace");
	let releaseDiagnostics!: () => void;
	try {
		await client.start();
		await client.check("/workspace/dependency.py", "python", "before", new AbortController().signal);
		lsp.diagnose.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseDiagnostics = () => resolve([]);
				}),
		);
		const pending = client.check("/workspace/main.py", "python", "main", new AbortController().signal);
		const rejectedDiagnostics = expect(pending).rejects.toThrow("Guest dependency changed");
		await vi.advanceTimersByTimeAsync(0);
		contents.set("/workspace/dependency.py", "after");
		await vi.advanceTimersByTimeAsync(1000);
		releaseDiagnostics();
		await rejectedDiagnostics;
	} finally {
		releaseDiagnostics?.();
		await client.stop();
	}
});
