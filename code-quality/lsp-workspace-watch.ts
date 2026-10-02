import { lstatSync, watch as watchNative, type Stats } from "node:fs";
import { platform } from "node:os";
import { relative, resolve } from "node:path";
import { watch as watchPortable } from "chokidar";
import { FileChangeType } from "vscode-languageserver-protocol";
import { inside } from "./paths.js";

export interface LspWorkspaceWatcher {
	ready: Promise<void>;
	close(): Promise<void>;
}

type WorkspaceChanged = (path: string, type: FileChangeType) => void;

function excludedWorkspacePath(root: string, path: string): boolean {
	const workspacePath = relative(root, path);
	return (
		/(?:^|[/\\])(?:\.git|node_modules|target|obj|bin|\.venv)(?:[/\\]|$)/.test(workspacePath) ||
		workspacePath.endsWith("probe-trace.json")
	);
}

function nativeFileChange(path: string, event: "rename" | "change"): FileChangeType {
	let stat: Stats;
	try {
		stat = lstatSync(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return FileChangeType.Deleted;
		}
		throw error;
	}
	if (stat.isSymbolicLink()) {
		// Retire any old document overlay without reading the replacement's target.
		return FileChangeType.Deleted;
	}
	return event === "rename" ? FileChangeType.Created : FileChangeType.Changed;
}

export function watchLspWorkspace(
	root: string,
	changed: WorkspaceChanged,
	failed: (error: Error) => void,
): LspWorkspaceWatcher {
	let stopped = false;
	let closeWatcher: (() => void | Promise<void>) | undefined;
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		stopped = true;
		closing ??= Promise.resolve().then(() => closeWatcher?.());
		return closing;
	};
	const reportFailure = (error: unknown) => {
		if (stopped) {
			return;
		}
		failed(error instanceof Error ? error : new Error(String(error)));
		void close().catch(() => {});
	};
	const publishChange: WorkspaceChanged = (path, type) => {
		if (!stopped && !excludedWorkspacePath(root, path)) {
			changed(path, type);
		}
	};
	const ready = new Promise<void>((resolveReady, rejectReady) => {
		const failStartup = (error: unknown) => {
			reportFailure(error);
			rejectReady(error);
		};
		try {
			if (platform() === "darwin") {
				const watcher = watchNative(root, { recursive: true }, (event, filename) => {
					if (stopped) {
						return;
					}
					try {
						if (filename === null) {
							throw new Error("Workspace watcher reported a change without a path");
						}
						const path = resolve(root, filename);
						if (!inside(root, path)) {
							throw new Error("Workspace watcher reported a path outside its root");
						}
						if (excludedWorkspacePath(root, path)) {
							return;
						}
						publishChange(path, nativeFileChange(path, event));
					} catch (error) {
						reportFailure(error);
					}
				});
				closeWatcher = () => watcher.close();
				watcher.on("error", reportFailure);
				resolveReady();
				return;
			}
			const watcher = watchPortable(root, {
				ignoreInitial: true,
				followSymlinks: false,
				ignored: (path) => excludedWorkspacePath(root, path),
			});
			closeWatcher = () => watcher.close();
			watcher.on("error", failStartup);
			watcher.once("ready", resolveReady);
			watcher.on("all", (event, path) => {
				if (event === "add" || event === "addDir") {
					publishChange(path, FileChangeType.Created);
				} else if (event === "unlink" || event === "unlinkDir") {
					publishChange(path, FileChangeType.Deleted);
				} else if (event === "change") {
					publishChange(path, FileChangeType.Changed);
				}
			});
		} catch (error) {
			failStartup(error);
		}
	});
	void ready.catch(() => {});
	return { ready, close };
}
