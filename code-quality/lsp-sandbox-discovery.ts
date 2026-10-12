import { readFile } from "node:fs/promises";
import { LSP_PRESETS } from "./lsp-presets.js";
import { WORKSPACE_MARKERS } from "./lsp-setup-defaults.js";
import type { ProjectDiscovery } from "./lsp-setup.js";
import type { QualitySandbox } from "./sandbox.js";

export async function discoverSandboxLspFiles(
	sandbox: QualitySandbox,
	signal: AbortSignal,
	workspace = sandbox.session.environment.workspace,
): Promise<ProjectDiscovery & { manifestRevision?: string }> {
	signal.throwIfAborted();
	const script = await readFile(new URL("./lsp-sandbox-discovery.py", import.meta.url), "utf8");
	const result = await sandbox.session.execute({
		command: ["python3", "-c", script],
		cwd: workspace,
		input: Buffer.from(
			JSON.stringify({
				root: workspace,
				entryLimit: 10_000,
				excludedDirectories: [".git", "node_modules", "bin", "obj", "target", ".venv", "venv", "vendor"],
				sourceExtensions: LSP_PRESETS.flatMap((preset) => Object.keys(preset.extensions)),
				projectMarkers: Object.values(WORKSPACE_MARKERS).flat(),
				includeManifestRevision: true,
			}),
		),
		signal,
	});
	signal.throwIfAborted();
	if (result.code !== 0) {
		throw new Error(`Container language discovery failed: ${result.stderr}`);
	}
	const discovery = JSON.parse(result.output.toString("utf8")) as ProjectDiscovery & {
		manifestRevision?: string;
	};
	if (
		!Array.isArray(discovery.files) ||
		!discovery.files.every((file) => typeof file === "string") ||
		typeof discovery.truncated !== "boolean"
	) {
		throw new Error("Invalid container language discovery result");
	}
	return discovery;
}
