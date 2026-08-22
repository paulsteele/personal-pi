import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { HStack, ScrollView } from "@earendil-works/pi-tui";

const PI_084_FULLSCREEN_LAYOUT_ADAPTER = Symbol("pi-atelier.fullscreen-layout-adapter");
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

interface FooterSlotState {
	entry: { minSize?: number };
	originalMinSize: number | undefined;
	collapsed: boolean;
}

interface FullscreenLayoutAdapterState {
	owner: object;
	originalRoot: Component;
	splitRoot: Component;
	sidebarComponent: Component;
	footerSlot?: FooterSlotState;
}

interface PrivateLayoutNode {
	type?: unknown;
	entries?: Array<{ component?: Component; minSize?: number }>;
}

type AdaptedTui = TUI & {
	[PI_084_FULLSCREEN_LAYOUT_ADAPTER]: FullscreenLayoutAdapterState | undefined;
	layoutRoot?: Component;
	setLayoutRoot(component: Component | undefined): void;
};

export const SIDEBAR_WIDTH = 44;
export const MIN_SIDEBAR_WIDTH = 28;
export const MIN_MAIN_WIDTH = 64;
export const MIN_VISIBLE_WIDTH = MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH;

export interface SplitPaneControllerOptions {
	onPresentationChange?(presented: boolean): void;
}

export interface SplitPaneController {
	attach(tui: TUI, sidebarComponent?: Component): void;
	show(): void;
	hide(): void;
	isEnabled(): boolean;
	isVisibleAtWidth(terminalWidth: number): boolean;
	isPresented(): boolean;
	overlayOptions(): OverlayOptions;
	requestRender(): void;
	dispose(): void;
}

/**
 * Owns the fixed Pi 0.84 fullscreen split. The custom overlay remains only as
 * a lifecycle/theme acquisition seam and is never itself visible.
 */
export function createSplitPaneController(options: SplitPaneControllerOptions = {}): SplitPaneController {
	let tui: TUI | undefined;
	let sidebarComponent: Component | undefined;
	let enabled = false;
	let lastPresented = false;
	let disposed = false;
	const adapterOwner = {};

	const safely = (action: () => unknown): void => {
		try {
			const result = action();
			if (result && typeof (result as PromiseLike<unknown>).then === "function") {
				void Promise.resolve(result).catch(() => undefined);
			}
		} catch {
			// Cleanup and private-adapter reconciliation are best effort.
		}
	};

	const layoutNode = (component: Component): PrivateLayoutNode | undefined => {
		const candidate = component as Component & { [LAYOUT_NODE]?: () => PrivateLayoutNode };
		try {
			return typeof candidate[LAYOUT_NODE] === "function" ? candidate[LAYOUT_NODE]() : undefined;
		} catch {
			return undefined;
		}
	};

	const findFooterSlot = (root: Component): FooterSlotState | undefined => {
		const rootNode = layoutNode(root);
		if (rootNode?.type !== "vstack" || !Array.isArray(rootNode.entries)) return undefined;
		// Pi 0.84's root is [transcript ScrollView, dock VStack]. The dock's final
		// entry is the footer container with minSize 1. Require this exact shape.
		const dock = rootNode.entries[1]?.component;
		if (!dock) return undefined;
		const dockNode = layoutNode(dock);
		if (dockNode?.type !== "vstack" || !Array.isArray(dockNode.entries) || dockNode.entries.length < 1) {
			return undefined;
		}
		const entry = dockNode.entries.at(-1);
		if (!entry || entry.minSize !== 1) return undefined;
		return { entry, originalMinSize: entry.minSize, collapsed: false };
	};

	const isPiFullscreenRenderer = (): boolean => {
		if (!tui || tui.mode !== "fullscreen") return false;
		const prototype = Object.getPrototypeOf(tui) as { constructor?: { name?: string } } | null;
		return prototype?.constructor?.name === "TuiAltScreen";
	};

	const visibleAt = (terminalWidth: number): boolean =>
		enabled && Number.isFinite(terminalWidth) && terminalWidth >= MIN_VISIBLE_WIDTH;

	const ownedState = (): FullscreenLayoutAdapterState | undefined => {
		if (!tui || !isPiFullscreenRenderer()) return undefined;
		const adaptedTui = tui as AdaptedTui;
		const state = adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER];
		return state?.owner === adapterOwner && adaptedTui.layoutRoot === state.splitRoot ? state : undefined;
	};

	const presented = (): boolean =>
		ownedState() !== undefined && visibleAt(tui?.terminal.columns ?? Number.NaN);

	const notifyPresentation = (): void => {
		const next = presented();
		if (next === lastPresented) return;
		lastPresented = next;
		try {
			options.onPresentationChange?.(next);
		} catch {
			// Presentation observers are advisory and must not break layout.
		}
	};

	const syncFooterSlot = (state: FullscreenLayoutAdapterState): void => {
		const slot = state.footerSlot;
		if (!slot) return;
		const shouldCollapse = visibleAt(tui?.terminal.columns ?? Number.NaN);
		if (slot.collapsed === shouldCollapse) return;
		if (shouldCollapse) slot.entry.minSize = 0;
		else if (slot.originalMinSize === undefined) delete slot.entry.minSize;
		else slot.entry.minSize = slot.originalMinSize;
		slot.collapsed = shouldCollapse;
	};

	const restoreFooterSlot = (state: FullscreenLayoutAdapterState): void => {
		const slot = state.footerSlot;
		if (!slot) return;
		if (slot.originalMinSize === undefined) delete slot.entry.minSize;
		else slot.entry.minSize = slot.originalMinSize;
		slot.collapsed = false;
	};

	const createFullscreenSplitRoot = (originalRoot: Component, pane: Component): Component =>
		new HStack([
			{ component: originalRoot, basis: 0, grow: 1, shrink: 1, minSize: MIN_MAIN_WIDTH },
			{
				component: pane,
				basis: SIDEBAR_WIDTH,
				grow: 0,
				shrink: 1,
				minSize: MIN_SIDEBAR_WIDTH,
				maxSize: SIDEBAR_WIDTH,
				visible: ({ width }) => {
					const state = ownedState();
					if (state) syncFooterSlot(state);
					notifyPresentation();
					return visibleAt(width);
				},
			},
		]);

	const syncFullscreenLayoutAdapter = (): void => {
		if (!enabled || !isPiFullscreenRenderer() || !sidebarComponent || !tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER];
		const currentRoot = adaptedTui.layoutRoot;

		if (currentState) {
			// Never stack over another owner or recapture a root replaced after ours.
			if (currentState.owner !== adapterOwner || currentRoot !== currentState.splitRoot) return;
			syncFooterSlot(currentState);
			if (currentState.sidebarComponent === sidebarComponent) return;
			const pane = new ScrollView(sidebarComponent, {
				primary: false,
				overscroll: "contain",
				scrollbar: "auto",
			});
			const splitRoot = createFullscreenSplitRoot(currentState.originalRoot, pane);
			adaptedTui.setLayoutRoot(splitRoot);
			currentState.splitRoot = splitRoot;
			currentState.sidebarComponent = sidebarComponent;
			return;
		}

		if (!currentRoot) return;
		const pane = new ScrollView(sidebarComponent, {
			primary: false,
			overscroll: "contain",
			scrollbar: "auto",
		});
		const splitRoot = createFullscreenSplitRoot(currentRoot, pane);
		const footerSlot = findFooterSlot(currentRoot);
		const nextState: FullscreenLayoutAdapterState = {
			owner: adapterOwner,
			originalRoot: currentRoot,
			splitRoot,
			sidebarComponent,
			...(footerSlot ? { footerSlot } : {}),
		};
		adaptedTui.setLayoutRoot(splitRoot);
		adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER] = nextState;
		syncFooterSlot(nextState);
	};

	const restoreFullscreenLayoutAdapter = (): void => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const state = adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER];
		if (state?.owner !== adapterOwner) return;
		restoreFooterSlot(state);
		if (adaptedTui.layoutRoot === state.splitRoot) adaptedTui.setLayoutRoot(state.originalRoot);
		adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER] = undefined;
	};

	const requestRender = (): void => {
		const state = ownedState();
		if (state) syncFooterSlot(state);
		notifyPresentation();
		tui?.requestRender();
	};

	const overlayLayout: OverlayOptions = {
		anchor: "top-right",
		width: SIDEBAR_WIDTH,
		maxHeight: "100%",
		margin: 0,
		nonCapturing: true,
		visible: () => {
			// Fullscreen content lives in the real ScrollView pane. Regular and
			// unknown renderers intentionally fail closed instead of using an overlay.
			syncFullscreenLayoutAdapter();
			requestRender();
			return false;
		},
	};

	return {
		attach(nextTui, nextSidebarComponent) {
			if (disposed) throw new Error("Cannot attach a disposed split pane");
			if (tui === nextTui) {
				if (nextSidebarComponent && nextSidebarComponent !== sidebarComponent) {
					sidebarComponent = nextSidebarComponent;
					syncFullscreenLayoutAdapter();
					requestRender();
				}
				return;
			}
			if (tui) throw new Error("Split pane is already attached to another TUI");
			tui = nextTui;
			sidebarComponent = nextSidebarComponent;
			syncFullscreenLayoutAdapter();
			requestRender();
		},
		show() {
			if (disposed || enabled) return;
			enabled = true;
			syncFullscreenLayoutAdapter();
			requestRender();
		},
		hide() {
			if (!enabled) return;
			enabled = false;
			requestRender();
		},
		isEnabled: () => enabled,
		isVisibleAtWidth: (terminalWidth) => visibleAt(terminalWidth),
		isPresented: presented,
		overlayOptions: () => overlayLayout,
		requestRender,
		dispose() {
			if (disposed) return;
			disposed = true;
			enabled = false;
			notifyPresentation();
			restoreFullscreenLayoutAdapter();
			safely(() => tui?.requestRender());
			tui = undefined;
			sidebarComponent = undefined;
		},
	};
}
