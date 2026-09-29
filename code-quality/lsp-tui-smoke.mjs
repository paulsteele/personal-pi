import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const directory = await mkdtemp(join(tmpdir(), "quality-tui-smoke-"));
const cwd = join(directory, "project");
const agentDir = join(directory, "agent");
await mkdir(cwd);
await mkdir(agentDir);
await writeFile(
	join(agentDir, "settings.json"),
	JSON.stringify({ defaultProjectTrust: "always", tuiMode: "fullscreen", quietStartup: true }),
);
await writeFile(join(cwd, "example.txt"), "clean");
const jiti = createJiti(import.meta.url);
const { resolveLspProject, saveLspDraft, loadLspDraft, approveLspDraft } =
	await jiti.import("./lsp-profile.ts");
const project = await resolveLspProject(cwd, agentDir);
const probeServerRoute = {
	id: "fixture",
	root: ".",
	preset: "custom",
	command: process.execPath,
	args: [fileURLToPath(new URL("./fixtures/lsp-probe-server.mjs", import.meta.url))],
	version: "1",
	extensions: { ".txt": "plaintext" },
	env: {},
	settings: {},
	initializationOptions: {},
	startupTimeoutMs: 10000,
	diagnosticTimeoutMs: 2000,
};
await saveLspDraft(agentDir, project, {
	version: 1,
	projectId: project.id,
	enabled: true,
	routes: [probeServerRoute],
});
await approveLspDraft(agentDir, project, (await loadLspDraft(agentDir, project)).revision);
const eventLog = join(directory, "events.jsonl");
console.log(JSON.stringify({ directory, cwd, agentDir, eventLog }));
execFileSync(
	"python3",
	[
		fileURLToPath(new URL("./fixtures/lsp-tui-smoke.py", import.meta.url)),
		directory,
		fileURLToPath(new URL("./index.ts", import.meta.url)),
		fileURLToPath(new URL("../pi-atelier/extensions/index.ts", import.meta.url)),
		fileURLToPath(new URL("./fixtures/lsp-tui-observer.ts", import.meta.url)),
	],
	{ stdio: "inherit", timeout: 60000 },
);
