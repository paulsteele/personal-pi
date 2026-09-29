import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function observeLspSmoke(pi: ExtensionAPI): void {
	const output = process.env.QUALITY_LSP_SMOKE_LOG;
	if (!output) throw new Error("QUALITY_LSP_SMOKE_LOG must identify the smoke-test event log");
	pi.events.on("code-quality:status", (status) => {
		appendFileSync(output, `${JSON.stringify({ kind: "quality", status })}\n`);
	});
	pi.on("session_start", () => {
		appendFileSync(output, `${JSON.stringify({ kind: "started", pid: process.pid })}\n`);
	});
	pi.on("session_shutdown", (event) => {
		appendFileSync(output, `${JSON.stringify({ kind: "shutdown", reason: event.reason })}\n`);
	});
}
