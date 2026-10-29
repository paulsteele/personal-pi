import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { LspClient } from "./lsp-client.js";
import { presetById, presetRoute } from "./lsp-presets.js";

const lifecycleServer = fileURLToPath(new URL("./fixtures/lsp-client-lifecycle-server.mjs", import.meta.url));
function roslynFixture(notifications: Array<{ method: string; type: number; message: string }>) {
	const route = presetRoute(presetById("roslyn"), process.execPath);
	route.args = [lifecycleServer];
	route.project = "application.sln";
	route.startupTimeoutMs = 3000;
	route.env = {
		EXPECTED_CLIENT_PROCESS_ID: JSON.stringify(process.pid),
		PROJECT_LOAD_MESSAGES: JSON.stringify(notifications),
	};
	const status = vi.fn();
	return { status, client: new LspClient(route, process.cwd(), status, vi.fn()) };
}
const sdkFailureDetail = [
	"[solution/open] [LanguageServerProjectSystem] Error while loading /workspace/Source/Core/Core.csproj: A compatible .NET SDK was not found.",
	"Requested SDK version: 10.0.102",
	"global.json file: /workspace/global.json",
	"Installed SDKs:",
	"10.0.109 [/opt/pi-tools/dotnet-runtime/10.0.109/sdk]",
].join("\n");

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

it.each(["window/logMessage", "window/showMessage"])(
	"surfaces Roslyn SDK load failures from %s despite initialization completion",
	async (method) => {
		const fixture = roslynFixture([
			{ method, type: 1, message: `${sdkFailureDetail}\n   at Microsoft.Build.Locator.FindMSBuild()` },
			{ method, type: 1, message: "Failed to initialize BuildHost process: later project failed" },
		]);
		const expectedReason = `C# project loading failed: ${sdkFailureDetail}`;
		try {
			await expect(fixture.client.start()).rejects.toThrow(expectedReason);
			expect(fixture.status).toHaveBeenCalledWith("failed", expectedReason);
			expect(fixture.status).not.toHaveBeenCalledWith("ready");
			expect(fixture.status.mock.calls.some(([, reason]) => reason?.includes("FindMSBuild"))).toBe(false);
		} finally {
			await fixture.client.stop();
		}
	},
);
it.each([
	"Failed to initialize BuildHost process: missing runtime",
	"Failed to load solution: project file missing",
	"Failed to load project /workspace/Core.csproj: missing SDK",
])("surfaces the project loader failure: %s", async (message) => {
	const fixture = roslynFixture([{ method: "window/logMessage", type: 1, message }]);
	try {
		await expect(fixture.client.start()).rejects.toThrow(`C# project loading failed: ${message}`);
		expect(fixture.status).not.toHaveBeenCalledWith("ready");
	} finally {
		await fixture.client.stop();
	}
});
it("bounds load failure details and removes terminal control characters", async () => {
	const message = `Error while loading /workspace/Core.csproj: \u001b${"x".repeat(5000)}`;
	const fixture = roslynFixture([{ method: "window/logMessage", type: 1, message }]);
	try {
		await expect(fixture.client.start()).rejects.toThrow("C# project loading failed:");
		const failure = fixture.status.mock.calls.find(([phase]) => phase === "failed")?.[1];
		expect(failure).toHaveLength("C# project loading failed: ".length + 3001);
		expect(failure).toMatch(/…$/);
		expect(failure).not.toContain("\u001b");
	} finally {
		await fixture.client.stop();
	}
});
it("does not turn warnings or unrelated error logs into project-load failures", async () => {
	const fixture = roslynFixture([
		{ method: "window/logMessage", type: 2, message: "Error while loading optional analyzer" },
		{ method: "window/logMessage", type: 1, message: "Telemetry upload failed" },
		{ method: "window/showMessage", type: 3, message: "Completed load of all projects" },
	]);
	try {
		await fixture.client.start();
		expect(fixture.status).toHaveBeenCalledWith("ready");
		expect(fixture.status.mock.calls.some(([phase]) => phase === "failed")).toBe(false);
	} finally {
		await fixture.client.stop();
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
