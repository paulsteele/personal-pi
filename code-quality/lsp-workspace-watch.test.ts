import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileChangeType } from "vscode-languageserver-protocol";
import { watchLspWorkspace } from "./lsp-workspace-watch.js";

const backends = vi.hoisted(() => ({
	platform: vi.fn(),
	native: vi.fn(),
	portable: vi.fn(),
	lstat: vi.fn(),
}));
vi.mock("node:os", () => ({ platform: backends.platform }));
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

it("ignores excluded build paths and symlinks without ignoring the workspace's own name", async () => {
	const fixture = watcherFixture("darwin");
	for (const path of [
		".git/index",
		"Source/obj/Generated.cs",
		"node_modules/pkg/index.js",
		"probe-trace.json",
	]) {
		fixture.nativeEvent("change", path);
	}
	backends.lstat.mockReturnValueOnce({ isSymbolicLink: () => true });
	fixture.nativeEvent("change", "Source/Linked.cs");
	expect(fixture.changed).not.toHaveBeenCalled();
	const nestedWorkspaceChange = vi.fn();
	const nestedWatcher = watchLspWorkspace("/workspace/target", nestedWorkspaceChange, vi.fn());
	backends.native.mock.calls[1]![2]("change", "App.cs");
	expect(nestedWorkspaceChange).toHaveBeenCalledWith("/workspace/target/App.cs", FileChangeType.Changed);
	await nestedWatcher.close();
	await fixture.watcher.close();
});

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
