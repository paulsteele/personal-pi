import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxDryManager } from "./dry-sandbox-manager.js";

export function dryStatusText(manager: Pick<SandboxDryManager, "status">): string {
	const status = manager.status;
	const lines = [
		`jscpd ${status.version ?? "unavailable"}: ${status.toolPhase}`,
		`Scan: ${status.scanPhase}; ${status.files} files, ${status.windows} windows, ${status.excluded} excluded`,
		`Scope: ${status.scope ?? "unresolved"}`,
	];
	if (status.baselinePhase) {
		lines.push(`Baseline phase: ${status.baselinePhase}`);
	}
	if (status.analyzedFiles !== undefined) {
		lines.push(`Detector: ${status.analyzedFiles} analyzed files; ${status.files} lexically indexed files`);
	}
	if (status.baselineDurationMs !== undefined && status.baselineTimings) {
		const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(2)}s`;
		const timings = status.baselineTimings;
		lines.push(
			`Baseline: ${seconds(status.baselineDurationMs)} total; capture ${seconds(timings.captureMs)}, detector ${seconds(timings.detectorMs)}, export preparation ${seconds(timings.exportPreparationMs)}, transfer/validation ${seconds(timings.transferValidationMs)}`,
		);
		lines.push(`Last lexical transfer: ${status.indexBytes ?? 0} bytes in ${status.indexShards ?? 0} shards`);
	}
	if (status.reason) {
		lines.push(status.reason);
	}
	if (status.warning) {
		lines.push(status.warning);
	}
	return lines.join("\n");
}
export interface DryCommandPorts {
	manager: Pick<SandboxDryManager, "status" | "refresh">;
	setEnabled(enabled: boolean, ctx: ExtensionContext, signal: AbortSignal): Promise<void>;
}
export async function handleDryCommand(
	action: string,
	ctx: ExtensionContext,
	ports: DryCommandPorts,
	signal: AbortSignal,
): Promise<void> {
	if (ctx.mode !== "tui") {
		throw new Error("DRY checking requires TUI mode");
	}
	if (!action || action === "status") {
		ctx.ui.notify(dryStatusText(ports.manager), "info");
		return;
	}
	if (!ctx.isIdle()) {
		throw new Error("Wait for the agent to finish before changing DRY state");
	}
	signal.throwIfAborted();
	switch (action) {
		case "refresh":
			await ports.manager.refresh(signal);
			return;
		case "on":
			await ports.setEnabled(true, ctx, signal);
			return;
		case "off":
			await ports.setEnabled(false, ctx, signal);
			return;
		default:
			throw new Error("Usage: /quality dry [status|refresh|on|off]");
	}
}
