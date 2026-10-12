import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entries = {
	permissionSystem: fileURLToPath(new URL("../pi-permission-system/src/index.ts", import.meta.url)),
	codeQuality: fileURLToPath(new URL("./index.ts", import.meta.url)),
	sidebarExtension: fileURLToPath(new URL("../pi-sidebar/extensions/index.ts", import.meta.url)),
	observerFixture: fileURLToPath(new URL("./fixtures/lsp-tui-observer.ts", import.meta.url)),
};
await Promise.all(Object.values(entries).map((path) => access(path)));
const directory = await mkdtemp(join(tmpdir(), "quality-tui-smoke-"));
const cwd = join(directory, "project");
const agentDir = join(directory, "agent");
await mkdir(cwd);
await mkdir(join(agentDir, "extensions", "code-quality"), { recursive: true });
await writeFile(
	join(agentDir, "settings.json"),
	JSON.stringify({ defaultProjectTrust: "always", tuiMode: "fullscreen", quietStartup: true }),
);
await writeFile(join(agentDir, "extensions", "code-quality", "config.json"), '{"enabled":false}');
const eventLog = join(directory, "events.jsonl");
console.log(JSON.stringify({ directory, cwd, agentDir, eventLog, scope: "Sidebar and unavailable mandatory sandbox UI; no live LSP certification" }));
execFileSync(
	"python3",
	[
		fileURLToPath(new URL("./fixtures/lsp-tui-smoke.py", import.meta.url)),
		directory,
		entries.permissionSystem,
		entries.codeQuality,
		entries.sidebarExtension,
		entries.observerFixture,
	],
	{ stdio: "inherit", timeout: 60000 },
);
