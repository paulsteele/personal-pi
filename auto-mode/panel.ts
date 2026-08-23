/**
 * Atelier sidebar panel publication.
 *
 * Uses Atelier's public contribution protocol (`registerSidebarPanel` on the
 * `pi-atelier:sidebar-panels` channel) rather than reaching into the fork's
 * internals. The publisher replays its registration when Atelier broadcasts a
 * discovery request, so either extension may load first.
 *
 * Atelier is an optional dependency: if the fork is absent, publication is a
 * no-op and auto mode still works, reporting through `ctx.ui.setStatus` alone.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describeDecision, explainDefer, footerLabel, type AutoModeSnapshot } from "./core.ts";

/** Namespaced panel id required by the protocol (`source:id`). */
export const PANEL_ID = "auto-mode:status" as const;

/** Rows rendered when the sidebar is presented. Pure, so it is unit-testable. */
export function buildPanelRows(snapshot: AutoModeSnapshot): Array<{ text: string; role?: string }> {
	const rows: Array<{ text: string; role?: string }> = [];

	rows.push({ text: footerLabel(snapshot), role: snapshot.enabled ? "ready" : "dim" });
	rows.push({ text: `model ${snapshot.modelId}`, role: "dim" });

	if (snapshot.enabled && !snapshot.usable) {
		rows.push({ text: "no classifier model configured", role: "warning" });
		return rows;
	}

	if (snapshot.enabled) {
		rows.push({
			text: `allowed ${snapshot.allowed}   denied ${snapshot.denied}   asked ${snapshot.escalated}`,
			role: "muted",
		});
	}

	if (snapshot.recent.length > 0) {
		rows.push({ text: "", role: "dim" });
		for (const decision of snapshot.recent) {
			rows.push({
				text: describeDecision(decision),
				role: decision.verdict === "deny" ? "error" : decision.verdict === "allow" ? "ready" : "warning",
			});
			// A denial is only useful if the operator can see why.
			if (decision.verdict === "deny" && decision.reason) {
				rows.push({ text: `  ${decision.reason}`, role: "dim" });
			}
			// So is an escalation: "why did auto mode still interrupt me?" is the
			// question this panel most needs to answer.
			if (decision.verdict === "defer") {
				const why = explainDefer(decision.deferReason);
				if (why) rows.push({ text: `  ${why}`, role: "dim" });
			}
		}
	}

	return rows;
}

export interface PanelPublisher {
	update(snapshot: AutoModeSnapshot): void;
	dispose(): void;
}

const NOOP: PanelPublisher = { update: () => undefined, dispose: () => undefined };

/**
 * Begin publishing the auto-mode panel.
 *
 * Resolution of Atelier's helper is asynchronous, so updates that arrive
 * before it loads are coalesced into the latest snapshot and flushed on
 * arrival — a decision made during startup must not be lost.
 */
export function publishPanel(pi: ExtensionAPI): PanelPublisher {
	let handle: { update(panel: unknown): void; dispose(): void } | undefined;
	let pending: AutoModeSnapshot | undefined;
	let disposed = false;

	const contribution = (snapshot: AutoModeSnapshot) => ({
		id: PANEL_ID,
		title: "Auto Mode",
		rows: buildPanelRows(snapshot),
		role: snapshot.enabled ? ("ready" as const) : ("dim" as const),
	});

	void (async () => {
		try {
			// Resolved from the local fork; absent in a stock Atelier install.
			const mod = (await import("../pi-atelier/src/sidebar-panels.ts")) as {
				registerSidebarPanel?: (
					api: Pick<ExtensionAPI, "events">,
					panel: unknown,
					options?: { source?: string },
				) => { update(panel: unknown): void; dispose(): void };
			};
			if (disposed || !mod.registerSidebarPanel) return;
			handle = mod.registerSidebarPanel(pi, contribution(pending ?? emptySnapshot()), { source: "auto-mode" });
			if (pending) handle.update(contribution(pending));
		} catch {
			// Atelier fork not present — the footer status remains the only surface.
		}
	})();

	return {
		update(snapshot) {
			if (disposed) return;
			pending = snapshot;
			handle?.update(contribution(snapshot));
		},
		dispose() {
			disposed = true;
			handle?.dispose();
			handle = undefined;
			pending = undefined;
		},
	};
}

function emptySnapshot(): AutoModeSnapshot {
	return {
		enabled: false,
		usable: false,
		modelId: "unconfigured",
		allowed: 0,
		denied: 0,
		escalated: 0,
		recent: [],
	};
}
