import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { HStack, ScrollView } from "@earendil-works/pi-tui";

const PI_084_FULLSCREEN_LAYOUT_ADAPTER = Symbol("pi-atelier.fullscreen-layout-adapter");

interface FullscreenLayoutAdapterState {
	owner: object;
	originalRoot: Component;
	splitRoot: Component;
	sidebarComponent: Component;
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
		const nextState: FullscreenLayoutAdapterState = {
			owner: adapterOwner,
			originalRoot: currentRoot,
			splitRoot,
			sidebarComponent,
		};
		adaptedTui.setLayoutRoot(splitRoot);
		adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER] = nextState;
	};

	const restoreFullscreenLayoutAdapter = (): void => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const state = adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER];
		if (state?.owner !== adapterOwner) return;
		if (adaptedTui.layoutRoot === state.splitRoot) adaptedTui.setLayoutRoot(state.originalRoot);
		adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER] = undefined;
	};

	const requestRender = (): void => {
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
