/**
 * Legacy Auto Mode panel helpers retained for test compatibility.
 * The live extension now publishes state/decisions into Atelier Activity.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describeDecision, explainDefer, footerLabel, type AutoModeSnapshot } from "./core.ts";

export const PANEL_ID = "auto-mode:status" as const;

export function buildPanelRows(snapshot: AutoModeSnapshot): Array<{ text: string; role?: string }> {
	const rows: Array<{ text: string; role?: string }> = [];
	rows.push({ text: footerLabel(snapshot), role: snapshot.enabled ? "ready" : "dim" });
	rows.push({ text: `model ${snapshot.modelId}`, role: "dim" });
	if (snapshot.enabled && !snapshot.usable) {
		rows.push({ text: "no classifier model configured", role: "warning" });
		return rows;
	}
	if (snapshot.enabled) rows.push({ text: `allowed ${snapshot.allowed}   denied ${snapshot.denied}   asked ${snapshot.escalated}`, role: "muted" });
	for (const decision of snapshot.recent) {
		rows.push({ text: describeDecision(decision), role: decision.verdict === "deny" ? "error" : decision.verdict === "allow" ? "ready" : "warning" });
		const why = decision.verdict === "defer" ? decision.reason ?? explainDefer(decision.deferReason) : decision.reason;
		if (why) rows.push({ text: `  ${why}`, role: "dim" });
	}
	return rows;
}

export interface PanelPublisher { update(snapshot: AutoModeSnapshot): void; dispose(): void; }

/** Deprecated no-op adapter. The extension no longer contributes a panel. */
export function publishPanel(_pi: ExtensionAPI): PanelPublisher {
	return { update: () => undefined, dispose: () => undefined };
}
