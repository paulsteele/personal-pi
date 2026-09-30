import { EventEmitter } from "node:events";
import { lstatSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { FileChangeType } from "vscode-languageserver-protocol";
import { watchLspWorkspace } from "./lsp-workspace-watch.js";
import { LspClient } from "./lsp-client.js";
import { presetById, presetRoute } from "./lsp-presets.js";

const backends = vi.hoisted(() => ({
	platform: vi.fn(),
	native: vi.fn(),
	portable: vi.fn(),
	lstat: vi.fn(),
}));
vi.mock("node:os", async (original) => ({
	...(await original<typeof import("node:os")>()),
	platform: backends.platform,
}));
vi.mock("node:fs", async (original) => ({
	...(await original<typeof import("node:fs")>()),
	watch: backends.native,
	lstatSync: backends.lstat,
}));
vi.mock("chokidar", () => ({ watch: backends.portable }));
afterEach(() => vi.resetAllMocks());

function watcherFixture(platform: "darwin" | "linux") {
	backends.platform.mockReturnValue(platform);
	backends.lstat.mockReturnValue({ isSymbolicLink: () => false });
	const backend = Object.assign(new EventEmitter(), { close: vi.fn() });
	backends.native.mockReturnValue(backend);
	backends.portable.mockReturnValue(backend);
	const changed = vi.fn();
	const failed = vi.fn();
	const root = "/workspace";
	const watcher = watchLspWorkspace(root, changed, failed);
	const nativeEvent = (event: "rename" | "change", filename: string | null) => {
		backends.native.mock.calls[0]![2](event, filename);
	};
	return { backend, changed, failed, root, watcher, nativeEvent };
}

it("uses one native recursive watcher on macOS, including package dependency changes", async () => {
	const fixture = watcherFixture("darwin");
	await fixture.watcher.ready;
	expect(backends.native).toHaveBeenCalledExactlyOnceWith(
		fixture.root,
		{ recursive: true },
		expect.any(Function),
	);
	expect(backends.portable).not.toHaveBeenCalled();
	fixture.nativeEvent("change", "Source/App.cs");
	fixture.nativeEvent("change", "packages/library/Dependency.dll");
	fixture.nativeEvent("rename", "Source/New.cs");
	backends.lstat.mockImplementationOnce(() => {
		throw Object.assign(new Error("File removed"), { code: "ENOENT" });
	});
	fixture.nativeEvent("rename", "Source/Deleted.cs");
	expect(fixture.changed.mock.calls).toEqual([
		[join(fixture.root, "Source/App.cs"), FileChangeType.Changed],
		[join(fixture.root, "packages/library/Dependency.dll"), FileChangeType.Changed],
		[join(fixture.root, "Source/New.cs"), FileChangeType.Created],
		[join(fixture.root, "Source/Deleted.cs"), FileChangeType.Deleted],
	]);
	expect(fixture.failed).not.toHaveBeenCalled();
	await fixture.watcher.close();
});

it("ignores excluded build paths without ignoring the workspace's own name", async () => {
	const fixture = watcherFixture("darwin");
	for (const path of [
		".git/index",
		"Source/obj/Generated.cs",
		"node_modules/pkg/index.js",
		"probe-trace.json",
	]) {
		fixture.nativeEvent("change", path);
	}
	expect(fixture.changed).not.toHaveBeenCalled();
	const nestedWorkspaceChange = vi.fn();
	const nestedWatcher = watchLspWorkspace("/workspace/target", nestedWorkspaceChange, vi.fn());
	backends.native.mock.calls[1]![2]("change", "App.cs");
	expect(nestedWorkspaceChange).toHaveBeenCalledWith("/workspace/target/App.cs", FileChangeType.Changed);
	await nestedWatcher.close();
	await fixture.watcher.close();
});

it("publishes deletion for a queued child event after its parent becomes a regular file", async () => {
	const fixture = watcherFixture("darwin");
	const directory = await realpath(await mkdtemp("/tmp/lsp-native-event-"));
	try {
		const parent = join(directory, "Source");
		await mkdir(parent);
		await writeFile(join(parent, "App.cs"), "class App {}");
		await rm(parent, { recursive: true });
		await writeFile(parent, "replacement");
		const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
		backends.lstat.mockImplementationOnce(() => fs.lstatSync(join(parent, "App.cs")));
		fixture.nativeEvent("rename", "Source/App.cs");
		fixture.nativeEvent("change", "StillUsable.cs");
		expect(fixture.changed.mock.calls).toEqual([
			["/workspace/Source/App.cs", FileChangeType.Deleted],
			["/workspace/StillUsable.cs", FileChangeType.Changed],
		]);
		expect(fixture.failed).not.toHaveBeenCalled();
		expect(fixture.backend.close).not.toHaveBeenCalled();
	} finally {
		await fixture.watcher.close();
		await rm(directory, { recursive: true, force: true });
	}
});

function dependencyOverlayClient(root: string, dependency: string): LspClient {
	const route = {
		...presetRoute(presetById("typescript"), process.execPath),
		preset: "custom" as const,
		args: [fileURLToPath(new URL("./fixtures/lsp-dependency-server.mjs", import.meta.url))],
		extensions: { ".txt": "plaintext" },
		env: { PROBE_DEPENDENCY_URI: pathToFileURL(dependency).href },
	};
	return new LspClient(route, root, vi.fn(), vi.fn());
}

it("closes a dependency overlay replaced by a symlink before checking an unchanged dependent", async () => {
	const directory = await realpath(await mkdtemp("/tmp/lsp-native-symlink-"));
	const root = join(directory, "project");
	await mkdir(root);
	const dependency = join(root, "dependency.txt");
	const dependent = join(root, "dependent.txt");
	await writeFile(dependency, "dependency");
	await writeFile(dependent, "dependent");
	const client = dependencyOverlayClient(root, dependency);
	backends.platform.mockReturnValue("darwin");
	backends.native.mockReturnValue(Object.assign(new EventEmitter(), { close: vi.fn() }));
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	backends.lstat.mockImplementation(fs.lstatSync);
	let pendingChange = Promise.resolve();
	const changed = vi.fn((path, type) => {
		pendingChange = client.fileChanged(path, type);
	});
	const failed = vi.fn();
	const watcher = watchLspWorkspace(root, changed, failed);
	try {
		await client.start();
		await client.synchronize(dependency, "plaintext", "dependency");
		await client.synchronize(dependent, "plaintext", "dependent");
		expect(await client.diagnose(dependent, "plaintext", AbortSignal.timeout(5000))).toEqual([]);
		await unlink(dependency);
		await symlink(join(directory, "nonexistent-target"), dependency);
		backends.native.mock.calls[0]![2]("rename", "dependency.txt");
		await pendingChange;
		expect(changed).toHaveBeenCalledExactlyOnceWith(dependency, FileChangeType.Deleted);
		expect(lstatSync).toHaveBeenCalledWith(dependency);
		expect(failed).not.toHaveBeenCalled();
		expect(await client.diagnose(dependent, "plaintext", AbortSignal.timeout(5000))).toMatchObject([
			{ message: "Dependency overlay closed" },
		]);
	} finally {
		await watcher.close();
		await client.stop();
		await rm(directory, { recursive: true, force: true });
	}
}, 15000);

it("waits for portable discovery and normalizes its file and directory events", async () => {
	const fixture = watcherFixture("linux");
	let ready = false;
	void fixture.watcher.ready.then(() => {
		ready = true;
	});
	await Promise.resolve();
	expect(ready).toBe(false);
	expect(backends.native).not.toHaveBeenCalled();
	expect(backends.portable).toHaveBeenCalledWith(fixture.root, {
		ignoreInitial: true,
		followSymlinks: false,
		ignored: expect.any(Function),
	});
	fixture.backend.emit("ready");
	await fixture.watcher.ready;
	fixture.backend.emit("all", "add", "/workspace/App.cs");
	fixture.backend.emit("all", "change", "/workspace/App.cs");
	fixture.backend.emit("all", "unlink", "/workspace/App.cs");
	fixture.backend.emit("all", "addDir", "/workspace/Source");
	fixture.backend.emit("all", "unlinkDir", "/workspace/Source");
	expect(fixture.changed.mock.calls).toEqual([
		["/workspace/App.cs", FileChangeType.Created],
		["/workspace/App.cs", FileChangeType.Changed],
		["/workspace/App.cs", FileChangeType.Deleted],
		["/workspace/Source", FileChangeType.Created],
		["/workspace/Source", FileChangeType.Deleted],
	]);
	await fixture.watcher.close();
});

it.each(["darwin", "linux"] as const)(
	"reports %s watcher errors once and stops publishing changes",
	async (platform) => {
		const fixture = watcherFixture(platform);
		fixture.backend.emit("ready");
		await fixture.watcher.ready;
		const error = Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" });
		expect(() => fixture.backend.emit("error", error)).not.toThrow();
		fixture.backend.emit("error", error);
		if (platform === "darwin") {
			fixture.nativeEvent("change", "App.cs");
		} else {
			fixture.backend.emit("all", "change", "/workspace/App.cs");
		}
		await fixture.watcher.close();
		expect(fixture.failed).toHaveBeenCalledExactlyOnceWith(error);
		expect(fixture.changed).not.toHaveBeenCalled();
		expect(fixture.backend.close).toHaveBeenCalledOnce();
	},
);

it("rejects portable readiness when watching fails during the initial scan", async () => {
	const fixture = watcherFixture("linux");
	fixture.backend.emit("error", new Error("ENOSPC: watcher limit reached"));
	await expect(fixture.watcher.ready).rejects.toThrow("ENOSPC");
	expect(fixture.failed).toHaveBeenCalledOnce();
	await fixture.watcher.close();
});

it.each([null, "../outside.cs"])("reports unusable native event paths: %s", async (filename) => {
	const fixture = watcherFixture("darwin");
	fixture.nativeEvent("rename", filename);
	expect(fixture.failed).toHaveBeenCalledOnce();
	expect(fixture.changed).not.toHaveBeenCalled();
	await fixture.watcher.close();
});

it("reports a synchronous native startup failure through readiness and the failure callback", async () => {
	backends.platform.mockReturnValue("darwin");
	backends.native.mockImplementation(() => {
		throw new Error("EMFILE: native startup failed");
	});
	const failed = vi.fn();
	const watcher = watchLspWorkspace("/workspace", vi.fn(), failed);
	await expect(watcher.ready).rejects.toThrow("EMFILE");
	expect(failed).toHaveBeenCalledOnce();
	await watcher.close();
});
