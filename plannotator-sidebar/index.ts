import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ATELIER_PANEL_CHANNEL,
	ATELIER_PANEL_VERSION,
	PANEL_ID,
	PANEL_SOURCE,
	isAtelierDiscovery,
	reconstructProgress,
	snapshotRows,
	type ProgressSnapshot,
} from "./core.ts";

const WIDGET_KEY = "plannotator-progress";

type AtelierPanelEvent =
	| {
			version: 1;
			type: "register";
			source: string;
			revision: number;
			requestId?: string;
			panel: {
				id: string;
				title: string;
				rows: ReturnType<typeof snapshotRows>;
				role: "accent";
			};
	  }
	| {
			version: 1;
			type: "unregister";
			source: string;
			revision: number;
			id: string;
	  };

export default function plannotatorSidebar(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let snapshot: ProgressSnapshot | undefined;
	let registered = false;
	let revision = 0;
	let generation = 0;
	const timers = new Set<ReturnType<typeof setTimeout>>();

	const emit = (event: AtelierPanelEvent): void => {
		pi.events.emit(ATELIER_PANEL_CHANNEL, event);
	};

	const publish = (requestId?: string): void => {
		if (!snapshot) return;
		registered = true;
		emit({
			version: ATELIER_PANEL_VERSION,
			type: "register",
			source: PANEL_SOURCE,
			revision: ++revision,
			...(requestId ? { requestId } : {}),
			panel: {
				id: PANEL_ID,
				title: "Plan progress",
				rows: snapshotRows(snapshot),
				role: "accent",
			},
		});
	};

	const unregister = (): void => {
		if (!registered) return;
		registered = false;
		emit({
			version: ATELIER_PANEL_VERSION,
			type: "unregister",
			source: PANEL_SOURCE,
			revision: ++revision,
			id: PANEL_ID,
		});
	};

	const clearDuplicateWidget = (): void => {
		try {
			ctx?.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// Session replacement can invalidate a captured UI context between events.
		}
	};

	const refresh = (): void => {
		if (!ctx) return;
		let next: ProgressSnapshot | undefined;
		try {
			next = reconstructProgress(ctx.cwd, ctx.sessionManager.getBranch());
		} catch {
			next = undefined;
		}
		snapshot = next;
		if (snapshot) publish();
		else unregister();
		clearDuplicateWidget();
	};

	/**
	 * Plannotator may update its widget/state in another handler for the same
	 * event. Defer one tick so this compatibility layer observes the durable
	 * branch after all handlers and removes only Plannotator's duplicate widget.
	 */
	const scheduleRefresh = (): void => {
		const expected = generation;
		const timer = setTimeout(() => {
			timers.delete(timer);
			if (expected !== generation) return;
			refresh();
		}, 0);
		timer.unref?.();
		timers.add(timer);
	};

	const stopTimers = (): void => {
		generation += 1;
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	};

	const unsubscribeDiscovery = pi.events.on(ATELIER_PANEL_CHANNEL, (event) => {
		if (isAtelierDiscovery(event) && snapshot) publish(event.requestId);
	});

	pi.on("session_start", (_event, nextCtx) => {
		stopTimers();
		ctx = nextCtx;
		snapshot = undefined;
		registered = false;
		revision = 0;
		scheduleRefresh();
	});

	pi.on("session_shutdown", () => {
		stopTimers();
		unregister();
		ctx = undefined;
		snapshot = undefined;
	});

	pi.on("session_tree", scheduleRefresh);
	pi.on("session_compact", scheduleRefresh);
	pi.on("tool_execution_end", scheduleRefresh);
	pi.on("turn_end", scheduleRefresh);
	pi.on("agent_end", scheduleRefresh);

	// The extension factory is recreated on /reload, but keep the event-bus
	// disposer tied to this instance as a second guard for nonstandard teardown.
	pi.on("session_shutdown", () => unsubscribeDiscovery());
}
