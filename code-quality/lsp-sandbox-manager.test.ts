import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SandboxLspManager } from "./lsp-sandbox-manager.js";
import { presetById, presetRoute } from "./lsp-presets.js";
import {
	approveLspDraft,
	loadLspDraft,
	resolveLspProject,
	saveLspDraft,
	type LspProject,
	type LspRoute,
} from "./lsp-profile.js";
import type { QualitySandbox } from "./sandbox.js";

const clients = vi.hoisted(
	() =>
		[] as {
			start: ReturnType<typeof vi.fn>;
			stop: ReturnType<typeof vi.fn>;
		check: ReturnType<typeof vi.fn>;
		}[],
);
const constructedRoutes = vi.hoisted(() => [] as LspRoute[]);
const startClient = vi.hoisted(() => vi.fn(async (_signal?: AbortSignal) => {}));
vi.mock("./lsp-sandbox-client.js", () => ({
	SandboxLspClient: class {
		start = vi.fn(async () => startClient(this.ownerSignal));
		stop = vi.fn(async () => {});
		check = vi.fn(async () => []);
		constructor(
			_sandbox: unknown,
			route: LspRoute,
			_projectRoot: unknown,
			_statusCallback: unknown,
			_refreshCallback: unknown,
			private readonly ownerSignal?: AbortSignal,
		) {
			clients.push(this);
			constructedRoutes.push(route);
		}
	},
}));
beforeEach(() => {
	clients.length = 0;
	constructedRoutes.length = 0;
	startClient.mockReset();
});

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

function validationFixture(agentDir = "/private/agent") {
	const retirementListeners = new Set<() => Promise<void>>();
	const sandbox: QualitySandbox = {
		sessionId: "session",
		revision: () => "revision",
		session: {
			generation: 1,
			processSupervisor: "supervisor",
			environment: { container: "container", user: "root", workspace: "/workspace", configuration: {} },
			beforeContainerRetirement(listener) {
				retirementListeners.add(listener);
				return () => {
					retirementListeners.delete(listener);
				};
			},
			filesystem: {
				canonical: vi.fn(async (path) => path),
				read: async () => Buffer.alloc(0),
				write: async () => {},
				mkdir: async () => {},
				stat: async () => ({ file: true, directory: false, size: 0 }),
				list: async () => [],
			},
			execute: async () => ({
				output: Buffer.from(JSON.stringify({ files: ["app.py"], truncated: false })),
				stderr: "",
				code: 0,
			}),
		},
	};
	let availableSandbox: QualitySandbox | undefined = sandbox;
	const pi = {
		events: {
			emit: vi.fn((channel, request) => {
				if (channel === "sandbox:service:v1" && availableSandbox) {
					request.accept(availableSandbox);
				}
			}),
		},
	} as unknown as ExtensionAPI;
	const manager = new SandboxLspManager(pi, agentDir, vi.fn());
	const project: LspProject = { id: "a".repeat(64), kind: "projects", root: "/host/project" };
	const route = presetRoute(
		presetById("pyright"),
		"/opt/pi-quality-tools/pyright/1.1.414/node_modules/.bin/pyright-langserver",
	);
	return {
		manager,
		sandbox,
		pi,
		agentDir,
		project,
		route,
		retirementListeners,
		setService(value: QualitySandbox | undefined) {
			availableSandbox = value;
		},
	};
}

async function approvedProfileFixture(enabled = true) {
	const directory = await mkdtemp(join(tmpdir(), "sandbox-lsp-start-"));
	directories.push(directory);
	const root = join(directory, "project");
	await mkdir(root);
	const agentDir = join(directory, "agent");
	const fixture = validationFixture(agentDir);
	const project = await resolveLspProject(root, agentDir);
	await saveLspDraft(agentDir, project, {
		version: 1,
		projectId: project.id,
		enabled,
		routes: [fixture.route],
	});
	await approveLspDraft(agentDir, project, (await loadLspDraft(agentDir, project))!.revision);
	return { ...fixture, project, root };
}

it("starts approved servers immediately instead of leaving them connecting until the first edit", async () => {
	const fixture = await approvedProfileFixture();
	await fixture.manager.start(fixture.root, true);
	expect(clients).toHaveLength(1);
	expect(clients[0]!.start).toHaveBeenCalledTimes(1);
	expect(fixture.manager.statusText()).toBe("pyright: ready (Podman)");
	await fixture.manager.stop();
});

it("starts a fresh server after approval reload stops the validation client", async () => {
	const fixture = await approvedProfileFixture();
	await fixture.manager.validate(fixture.route, fixture.project, new AbortController().signal);
	await fixture.manager.stop();
	await fixture.manager.start(fixture.root, true);
	expect(clients).toHaveLength(2);
	expect(clients[0]!.stop).toHaveBeenCalledTimes(1);
	expect(clients[1]!.start).toHaveBeenCalledTimes(1);
	expect(fixture.manager.statusText()).toBe("pyright: ready (Podman)");
	await fixture.manager.stop();
});

it("loads an enabled profile as suspended while quality is off without requiring a sandbox", async () => {
	const fixture = await approvedProfileFixture();
	fixture.setService(undefined);
	await fixture.manager.start(fixture.root, true, false);
	expect(clients).toHaveLength(0);
	expect(fixture.manager.configRevision).not.toBe("unconfigured");
	expect(fixture.manager.statusText()).toContain(
		"LSP profile enabled; automatic checks suspended because quality is off",
	);
	expect(fixture.manager.header).toMatchObject([{ id: "pyright", phase: "stopped", clients: 0 }]);
	await fixture.manager.stop();
	const reloaded = new SandboxLspManager(fixture.pi, fixture.agentDir, vi.fn());
	await reloaded.start(fixture.root, true, false);
	expect(reloaded.statusText()).toContain("profile enabled; automatic checks suspended");
	expect(clients).toHaveLength(0);
});

it("resumes the saved enabled profile when the master quality switch is turned on", async () => {
	const fixture = await approvedProfileFixture();
	await fixture.manager.start(fixture.root, true, false);
	expect(
		await fixture.manager.check([{ path: "/workspace/app.py", after: "pass" }], new AbortController().signal),
	).toBeUndefined();
	await fixture.manager.start(fixture.root, true, true);
	expect(clients).toHaveLength(1);
	expect(fixture.manager.statusText()).toBe("pyright: ready (Podman)");
	await fixture.manager.stop();
});

it("does not launch saved routes when the approved profile is disabled", async () => {
	const fixture = await approvedProfileFixture(false);
	await fixture.manager.start(fixture.root, true);
	expect(clients).toHaveLength(0);
	expect(fixture.manager.statusText()).toBe("LSP checking disabled");
});

it("migrates realpath-resolved commands from the former private managed installation", async () => {
	const fixture = await approvedProfileFixture();
	const managedDirectory = join(fixture.agentDir, "extensions/code-quality/tools/pyright/1.1.414/darwin-arm64");
	await mkdir(managedDirectory, { recursive: true });
	const target = join(managedDirectory, "pyright-langserver.js");
	await writeFile(target, "legacy managed server");
	const link = join(managedDirectory, "pyright-langserver");
	await symlink("pyright-langserver.js", link);
	const route = { ...fixture.route, command: await realpath(link) };
	fixture.sandbox.session.environment.toolInventory = {
		version: 1,
		revision: "tools",
		tools: [
			{
				id: "pyright",
				version: "1.1.415",
				executable: "/opt/pi-tools/pyright/current/server",
			},
		],
	};
	const result = await fixture.manager.validate(route, fixture.project, new AbortController().signal);
	expect(result.ready).toBe(true);
	expect(constructedRoutes[0]).toMatchObject({ command: "/opt/pi-tools/pyright/current/server", version: "1.1.415" });
	expect(constructedRoutes[0]?.root).toBe(route.root);
	await fixture.manager.stop();
});

it("reports the startup failure in status rather than overwriting it with stopped", async () => {
	const fixture = await approvedProfileFixture();
	startClient.mockRejectedValueOnce(new Error("Language server exited (code 1): missing executable"));
	await expect(fixture.manager.start(fixture.root, true)).rejects.toThrow("missing executable");
	expect(fixture.manager.statusText()).toBe(
		"pyright: failed (Podman) — Error: Language server exited (code 1): missing executable",
	);
	expect(clients[0]!.stop).toHaveBeenCalledTimes(1);
});

it("validates a representative Python file through the sandbox's complete diagnostic client", async () => {
	const fixture = validationFixture();
	const result = await fixture.manager.validate(fixture.route, fixture.project, new AbortController().signal);
	expect(result).toEqual({
		ready: true,
		summary: "Language server returned complete project diagnostics inside Podman",
	});
	expect(clients).toHaveLength(1);
	expect(clients[0]!.start).toHaveBeenCalledTimes(1);
	expect(fixture.sandbox.session.filesystem.canonical).toHaveBeenCalledWith("/workspace", expect.any(AbortSignal));
	expect(fixture.retirementListeners.size).toBe(1);
	expect(clients[0]!.check).toHaveBeenCalledWith("/workspace/app.py", "python", "", expect.any(AbortSignal));
	await fixture.manager.stop();
});

it("reports diagnostic validation failure even when server initialization succeeds", async () => {
	const fixture = validationFixture();
	await fixture.manager.validate(fixture.route, fixture.project, new AbortController().signal);
	clients[0]!.check.mockRejectedValueOnce(new Error("Incomplete diagnostic report"));
	const result = await fixture.manager.validate(fixture.route, fixture.project, new AbortController().signal);
	expect(result).toEqual({ ready: false, summary: "Error: Incomplete diagnostic report" });
	expect(clients).toHaveLength(1);
	expect(clients[0]!.start).toHaveBeenCalledOnce();
	await fixture.manager.stop();
});

it("recovers setup validation when the sandbox becomes available after an earlier failure", async () => {
	const fixture = validationFixture();
	fixture.setService(undefined);
	expect(
		await fixture.manager.validate(fixture.route, fixture.project, new AbortController().signal),
	).toEqual({
		ready: false,
		summary: "Error: Quality requires the mandatory sandbox service",
	});
	expect(clients).toHaveLength(0);
	fixture.setService(fixture.sandbox);
	expect(
		(await fixture.manager.validate(fixture.route, fixture.project, new AbortController().signal)).ready,
	).toBe(true);
	expect(clients).toHaveLength(1);
	await fixture.manager.stop();
});

it("reuses the validation client within the same container generation", async () => {
	const fixture = validationFixture();
	const signal = new AbortController().signal;
	await fixture.manager.validate(fixture.route, fixture.project, signal);
	await fixture.manager.validate(fixture.route, fixture.project, signal);
	expect(clients).toHaveLength(1);
	expect(fixture.retirementListeners.size).toBe(1);
	await fixture.manager.stop();
});

it("retires validation clients and reconnects after container recreation", async () => {
	const fixture = validationFixture();
	const signal = new AbortController().signal;
	await fixture.manager.validate(fixture.route, fixture.project, signal);
	for (const retire of fixture.retirementListeners) {
		await retire();
	}
	expect(clients[0]!.stop).toHaveBeenCalledTimes(1);
	fixture.sandbox.session.generation = 2;
	fixture.sandbox.session.environment.container = "replacement-container";
	await fixture.manager.validate(fixture.route, fixture.project, signal);
	expect(clients).toHaveLength(2);
	expect(clients[1]!.start).toHaveBeenCalledTimes(1);
	expect(fixture.retirementListeners.size).toBe(1);
	await fixture.manager.stop();
});

it("cleans up a failed validation launch and creates a fresh client on retry", async () => {
	const fixture = validationFixture();
	const signal = new AbortController().signal;
	startClient.mockRejectedValueOnce(new Error("Language server exited (code 1)"));
	expect(await fixture.manager.validate(fixture.route, fixture.project, signal)).toEqual({
		ready: false,
		summary: "Error: Language server exited (code 1)",
	});
	expect(clients[0]!.stop).toHaveBeenCalledTimes(1);
	expect((await fixture.manager.validate(fixture.route, fixture.project, signal)).ready).toBe(true);
	expect(clients).toHaveLength(2);
	await fixture.manager.stop();
});

it("awaits a pending launch during retirement without publishing it as a ready client", async () => {
	const fixture = await approvedProfileFixture();
	let releaseLaunch!: () => void;
	const launchWait = new Promise<void>((resolve) => {
		releaseLaunch = resolve;
	});
	startClient.mockImplementationOnce(() => launchWait);
	const startup = fixture.manager.start(fixture.root, true);
	const rejectedStartup = expect(startup).rejects.toThrow();
	await vi.waitFor(() => expect(clients).toHaveLength(1));
	const retirement = fixture.manager.stop();
	releaseLaunch();
	await rejectedStartup;
	await retirement;
	expect(clients[0]!.stop).toHaveBeenCalledOnce();
	await fixture.manager.start(fixture.root, true);
	expect(clients).toHaveLength(2);
	expect(fixture.manager.statusText()).toBe("pyright: ready (Podman)");
	await fixture.manager.stop();
});

it("validates relative routes under the mapped project root instead of the startup subdirectory", async () => {
	const fixture = validationFixture();
	fixture.sandbox.guestPath = vi.fn(async () => "/workspace/project");
	fixture.sandbox.session.environment.workspace = "/workspace/project/subdirectory";
	const result = await fixture.manager.validate(fixture.route, fixture.project, new AbortController().signal);
	expect(result.ready).toBe(true);
	expect(fixture.sandbox.guestPath).toHaveBeenCalledWith("/host/project");
	expect(clients[0]!.check).toHaveBeenCalledWith("/workspace/project/app.py", "python", "", expect.any(AbortSignal));
	await fixture.manager.stop();
});

it("cancels a validation-owned pending launch without publishing a ready server", async () => {
	const fixture = validationFixture();
	startClient.mockImplementationOnce(async (signal) => {
		await new Promise<void>((_resolve, reject) => {
			signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
		});
	});
	const cancellation = new AbortController();
	const validating = fixture.manager.validate(fixture.route, fixture.project, cancellation.signal);
	await vi.waitFor(() => expect(clients[0]?.start).toHaveBeenCalledOnce());
	cancellation.abort(new Error("Cancelled validation"));
	expect(await validating).toEqual({ ready: false, summary: "Error: Cancelled validation" });
	await fixture.manager.stop();
	expect(clients[0]!.stop).toHaveBeenCalledOnce();
	expect(fixture.manager.header.some((status) => status.phase === "ready")).toBe(false);
	expect((await fixture.manager.validate(fixture.route, fixture.project, new AbortController().signal)).ready).toBe(true);
	expect(clients).toHaveLength(2);
	await fixture.manager.stop();
});

it("keeps a shared launch alive when only one validation waiter cancels", async () => {
	const fixture = validationFixture();
	let releaseLaunch!: () => void;
	const launchWait = new Promise<void>((resolve) => {
		releaseLaunch = resolve;
	});
	startClient.mockImplementationOnce(() => launchWait);
	const cancellation = new AbortController();
	const first = fixture.manager.validate(fixture.route, fixture.project, cancellation.signal);
	await vi.waitFor(() => expect(clients[0]?.start).toHaveBeenCalledOnce());
	const second = fixture.manager.validate(fixture.route, fixture.project, new AbortController().signal);
	await vi.waitFor(() => expect(fixture.sandbox.session.filesystem.canonical).toHaveBeenCalledTimes(3));
	cancellation.abort(new Error("Cancelled first waiter"));
	expect((await first).ready).toBe(false);
	expect(startClient.mock.calls[0]![0]!.aborted).toBe(false);
	releaseLaunch();
	expect((await second).ready).toBe(true);
	expect(clients).toHaveLength(1);
	await fixture.manager.stop();
});

it("rejects validation without creating a client when cancellation is already requested", async () => {
	const fixture = validationFixture();
	await expect(
		fixture.manager.validate(fixture.route, fixture.project, AbortSignal.abort()),
	).rejects.toThrow();
	expect(clients).toHaveLength(0);
});
