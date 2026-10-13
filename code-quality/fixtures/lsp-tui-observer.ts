import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function observeLspSmoke(pi: ExtensionAPI): void {
	const output = process.env.QUALITY_LSP_SMOKE_LOG;
	if (!output) throw new Error("QUALITY_LSP_SMOKE_LOG must identify the smoke-test event log");
	pi.events.on("code-quality:status", (status) => {
		appendFileSync(output, `${JSON.stringify({ kind: "quality", pid: process.pid, status })}\n`);
	});
	pi.events.on("sandbox:state:v1", (state) => {
		appendFileSync(output, `${JSON.stringify({ kind: "sandbox", pid: process.pid, state })}\n`);
	});
	pi.on("session_start", () => {
		const commands = pi.getCommands().map((command) => command.name);
		const sidebarLoaded = commands.includes("sidebar") && commands.includes("plugin-settings");
		if (!sidebarLoaded || !commands.includes("sandbox")) {
			throw new Error("Smoke requires the Sidebar and mandatory Permission System entries");
		}
		appendFileSync(output, `${JSON.stringify({ kind: "started", pid: process.pid, sidebarLoaded })}\n`);
	});
	pi.on("session_shutdown", (event) => {
		appendFileSync(
			output,
			`${JSON.stringify({ kind: "shutdown", pid: process.pid, reason: event.reason })}\n`,
		);
	});
}
