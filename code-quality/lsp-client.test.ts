import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { LspClient } from "./lsp-client.js";
import { presetById, presetRoute } from "./lsp-presets.js";

const lifecycleServer = fileURLToPath(new URL("./fixtures/lsp-client-lifecycle-server.mjs", import.meta.url));

it("omits host PID monitoring for a server in a different process namespace", async () => {
	const route = presetRoute(presetById("pyright"), process.execPath);
	route.startupTimeoutMs = 3000;
	const status = vi.fn();
	const client = new LspClient(route, process.cwd(), status, vi.fn(), undefined, {
		command: process.execPath,
		args: [lifecycleServer],
		cwd: process.cwd(),
		env: { ...process.env, EXPECTED_CLIENT_PROCESS_ID: "null" },
		clientProcessId: null,
		readFile: async () => "",
	});
	try {
		await client.start();
		expect(status).toHaveBeenCalledWith("ready");
	} finally {
		await client.stop();
	}
});

it("retains client PID monitoring for a local language server", async () => {
	const route = presetRoute(presetById("pyright"), process.execPath);
	route.args = [lifecycleServer];
	route.env = { EXPECTED_CLIENT_PROCESS_ID: JSON.stringify(process.pid) };
	route.startupTimeoutMs = 3000;
	const status = vi.fn();
	const client = new LspClient(route, process.cwd(), status, vi.fn());
	try {
		await client.start();
		expect(status).toHaveBeenCalledWith("ready");
	} finally {
		await client.stop();
	}
});

it("reports startup exit codes and stderr instead of masking them with a later guard-close failure", async () => {
	const route = presetRoute(presetById("pyright"), process.execPath);
	route.args = ["-e", 'process.stderr.write("runtime unavailable\\n"); process.exit(23);'];
	route.startupTimeoutMs = 3000;
	const status = vi.fn();
	const client = new LspClient(route, process.cwd(), status, vi.fn());
	try {
		await expect(client.start()).rejects.toThrow("Language server exited (code 23): runtime unavailable");
	} finally {
		await client.stop();
	}
	expect(status).toHaveBeenCalledWith("failed", "Language server exited (code 23): runtime unavailable");
	expect(status).not.toHaveBeenCalledWith("failed", "Language server guard closed");
});
