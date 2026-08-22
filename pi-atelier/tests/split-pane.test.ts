import type { Component, TUI } from "@earendil-works/pi-tui";
import { ScrollView, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	createSplitPaneController,
	MIN_MAIN_WIDTH,
	MIN_SIDEBAR_WIDTH,
	MIN_VISIBLE_WIDTH,
	SIDEBAR_WIDTH,
} from "../src/split-pane.js";

const sidebarComponent: Component = {
	render: (width: number) => [`sidebar:${width}`],
	invalidate() {},
};

function piFullscreenRoot(main: Component, footer: Component) {
	const transcript = new ScrollView(main, { primary: true });
	const dock = new VStack([
		{ component: { render: () => ["editor"], invalidate() {} }, minSize: 3 },
		{ component: footer, minSize: 1 },
	]);
	return { root: new VStack([{ component: transcript, grow: 1 }, { component: dock }]), dock };
}

function stableTuiReference(getRenderer: () => TUI): TUI {
	return new Proxy({} as TUI, {
		get: (_target, property) => {
			const renderer = getRenderer();
			const value = Reflect.get(renderer, property, renderer);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const currentRenderer = getRenderer();
				const method = Reflect.get(currentRenderer, property, currentRenderer);
				if (typeof method !== "function") throw new TypeError(`${String(property)} is not callable`);
				return Reflect.apply(method, currentRenderer, args);
			};
		},
		set: (_target, property, value) => Reflect.set(getRenderer(), property, value, getRenderer()),
		getPrototypeOf: () => Reflect.getPrototypeOf(getRenderer()),
	}) as TUI;
}

function fullscreenRenderer(columns = 120, rows = 36) {
	const renderer = new TuiAltScreen({ columns, rows, write: vi.fn() } as never);
	renderer.requestRender = vi.fn();
	return renderer;
}

function unknownRenderer(mode: "regular" | "fullscreen" = "fullscreen") {
	const root: Component = { render: (width) => [`main:${width}`], invalidate() {} };
	return {
		mode,
		terminal: { columns: 120, rows: 36, write: vi.fn() },
		requestRender: vi.fn(),
		render: vi.fn((width: number) => root.render(width)),
		layoutRoot: root,
		setLayoutRoot: vi.fn(),
	} as unknown as TUI;
}

const press = (x: number, y = 1) => `\u001b[<0;${x};${y}M`;
const motion = (x: number, y = 1) => `\u001b[<32;${x};${y}M`;
const release = (x: number, y = 1) => `\u001b[<0;${x};${y}m`;

describe("fixed fullscreen split", () => {
	it("uses the fixed width and visibility boundary", () => {
		expect(SIDEBAR_WIDTH).toBe(44);
		expect(MIN_SIDEBAR_WIDTH).toBe(28);
		expect(MIN_MAIN_WIDTH).toBe(64);
		expect(MIN_VISIBLE_WIDTH).toBe(92);

		const split = createSplitPaneController();
		expect(split.isVisibleAtWidth(120)).toBe(false);
		split.show();
		expect(split.isVisibleAtWidth(91)).toBe(false);
		expect(split.isVisibleAtWidth(92)).toBe(true);
	});

	it("reserves fixed fullscreen columns and restores them when hidden", () => {
		const renderer = fullscreenRenderer(120);
		const widths: number[] = [];
		const originalRoot: Component = {
			render(width) {
				widths.push(width);
				return [`main:${width}`];
			},
			invalidate() {},
		};
		renderer.setLayoutRoot(originalRoot);
		const split = createSplitPaneController();
		split.attach(
			stableTuiReference(() => renderer),
			sidebarComponent,
		);
		split.show();

		const lines = renderer.render(120);
		expect(widths.at(-1)).toBe(76);
		expect(lines.join("\n")).toContain("sidebar:44");
		expect(split.isPresented()).toBe(true);
		expect(split.overlayOptions().visible?.(120, 36)).toBe(false);

		split.hide();
		renderer.render(120);
		expect(widths.at(-1)).toBe(120);
		expect(split.isPresented()).toBe(false);
	});

	it("shrinks to 28 columns before hiding below 92 columns", () => {
		const renderer = fullscreenRenderer(100);
		const widths: number[] = [];
		renderer.setLayoutRoot({
			render(width) {
				widths.push(width);
				return [`main:${width}`];
			},
			invalidate() {},
		});
		const split = createSplitPaneController();
		split.attach(
			stableTuiReference(() => renderer),
			sidebarComponent,
		);
		split.show();

		let lines = renderer.render(100);
		expect(widths.at(-1)).toBe(64);
		expect(lines.join("\n")).toContain("sidebar:36");

		(renderer.terminal as { columns: number }).columns = 92;
		lines = renderer.render(92);
		expect(widths.at(-1)).toBe(64);
		expect(lines.join("\n")).toContain("sidebar:28");

		(renderer.terminal as { columns: number }).columns = 91;
		renderer.render(91);
		expect(widths.at(-1)).toBe(91);
		expect(split.isPresented()).toBe(false);
	});

	it("reports presentation changes for ownership, width, visibility, and disposal", () => {
		const changes: boolean[] = [];
		const renderer = fullscreenRenderer(120);
		renderer.setLayoutRoot({ render: (width) => [`main:${width}`], invalidate() {} });
		const split = createSplitPaneController({ onPresentationChange: (value) => changes.push(value) });
		split.attach(
			stableTuiReference(() => renderer),
			sidebarComponent,
		);
		split.show();
		expect(split.isPresented()).toBe(true);

		(renderer.terminal as { columns: number }).columns = 91;
		renderer.render(91);
		expect(split.isPresented()).toBe(false);
		(renderer.terminal as { columns: number }).columns = 120;
		renderer.render(120);
		expect(split.isPresented()).toBe(true);
		split.hide();
		expect(split.isPresented()).toBe(false);
		split.show();
		expect(split.isPresented()).toBe(true);
		split.dispose();
		expect(split.isPresented()).toBe(false);
		expect(changes).toEqual([true, false, true, false, true, false]);
	});

	it("collapses and restores Pi's fullscreen footer slot", () => {
		const renderer = fullscreenRenderer(120, 8);
		const layout = piFullscreenRoot(
			{ render: () => ["main"], invalidate() {} },
			{ render: () => ["footer"], invalidate() {} },
		);
		const dockEntries = (layout.dock as unknown as { entries: Array<{ minSize?: number }> }).entries;
		renderer.setLayoutRoot(layout.root);
		const split = createSplitPaneController();
		split.attach(
			stableTuiReference(() => renderer),
			sidebarComponent,
		);
		split.show();
		expect(dockEntries.at(-1)?.minSize).toBe(0);

		(renderer.terminal as { columns: number }).columns = 91;
		renderer.render(91);
		expect(dockEntries.at(-1)?.minSize).toBe(1);
		(renderer.terminal as { columns: number }).columns = 120;
		renderer.render(120);
		expect(dockEntries.at(-1)?.minSize).toBe(0);

		split.hide();
		expect(dockEntries.at(-1)?.minSize).toBe(1);
		split.show();
		split.dispose();
		expect(dockEntries.at(-1)?.minSize).toBe(1);
	});

	it("keeps clipboard selection inside the pane where dragging began", async () => {
		let deliverInput: ((data: string) => void) | undefined;
		const copied: string[] = [];
		const terminal = {
			columns: 120,
			rows: 8,
			write: vi.fn(),
			start: vi.fn((onInput: (data: string) => void) => {
				deliverInput = onInput;
			}),
			stop: vi.fn(),
			hideCursor: vi.fn(),
			showCursor: vi.fn(),
		};
		const renderer = new TuiAltScreen(terminal as never, false, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const main = new ScrollView(
			{ render: () => ["MAIN alpha", "MAIN beta"], invalidate() {} },
			{ primary: true },
		);
		renderer.setLayoutRoot(piFullscreenRoot(main, { render: () => [], invalidate() {} }).root);
		renderer.start();
		const split = createSplitPaneController();
		split.attach(
			stableTuiReference(() => renderer),
			{
				render: () => ["SIDE one", "SIDE two"],
				invalidate() {},
			},
		);
		split.show();
		renderer.renderNow();
		const send = async (data: string) => {
			deliverInput?.(data);
			await Promise.resolve();
		};

		await send(press(2));
		await send(motion(110, 2));
		await send(release(110, 2));
		await send(press(77));
		await send(motion(2, 2));
		await send(release(2, 2));

		expect(copied[0]).toContain("MAIN");
		expect(copied[0]).not.toContain("SIDE");
		expect(copied[1]).toContain("SIDE");
		expect(copied[1]).not.toContain("MAIN");
		split.dispose();
		renderer.stop();
	});
});

describe("fullscreen adapter ownership", () => {
	it("restores the original root on disposal", () => {
		const renderer = fullscreenRenderer();
		const originalRoot: Component = { render: (width) => [`main:${width}`], invalidate() {} };
		renderer.setLayoutRoot(originalRoot);
		const split = createSplitPaneController();
		split.attach(
			stableTuiReference(() => renderer),
			sidebarComponent,
		);
		split.show();
		expect((renderer as unknown as { layoutRoot: unknown }).layoutRoot).not.toBe(originalRoot);
		split.dispose();
		expect((renderer as unknown as { layoutRoot: unknown }).layoutRoot).toBe(originalRoot);
	});

	it("does not overwrite a layout installed later and no longer reports presentation", () => {
		const renderer = fullscreenRenderer();
		const originalRoot: Component = { render: (width) => [`main:${width}`], invalidate() {} };
		const laterRoot: Component = { render: (width) => [`later:${width}`], invalidate() {} };
		renderer.setLayoutRoot(originalRoot);
		const split = createSplitPaneController();
		split.attach(
			stableTuiReference(() => renderer),
			sidebarComponent,
		);
		split.show();
		renderer.setLayoutRoot(laterRoot);
		expect(split.isPresented()).toBe(false);
		split.dispose();
		expect((renderer as unknown as { layoutRoot: unknown }).layoutRoot).toBe(laterRoot);
	});

	it("does not stack over another active split owner", () => {
		const renderer = fullscreenRenderer();
		renderer.setLayoutRoot({ render: (width) => [`main:${width}`], invalidate() {} });
		const first = createSplitPaneController();
		const second = createSplitPaneController();
		const tui = stableTuiReference(() => renderer);
		first.attach(tui, sidebarComponent);
		first.show();
		const firstRoot = (renderer as unknown as { layoutRoot: unknown }).layoutRoot;
		second.attach(tui, sidebarComponent);
		second.show();
		expect((renderer as unknown as { layoutRoot: unknown }).layoutRoot).toBe(firstRoot);
		expect(first.isPresented()).toBe(true);
		expect(second.isPresented()).toBe(false);
		second.dispose();
		expect((renderer as unknown as { layoutRoot: unknown }).layoutRoot).toBe(firstRoot);
		first.dispose();
	});

	it("is idempotent across repeated attach, show, hide, request, and dispose", () => {
		const renderer = fullscreenRenderer();
		const originalRoot: Component = { render: (width) => [`main:${width}`], invalidate() {} };
		renderer.setLayoutRoot(originalRoot);
		const tui = stableTuiReference(() => renderer);
		const split = createSplitPaneController();
		split.attach(tui, sidebarComponent);
		split.attach(tui, sidebarComponent);
		split.show();
		split.show();
		split.requestRender();
		split.hide();
		split.hide();
		split.dispose();
		split.dispose();
		expect((renderer as unknown as { layoutRoot: unknown }).layoutRoot).toBe(originalRoot);
	});

	it("rejects attachment to a second TUI", () => {
		const first = fullscreenRenderer();
		const second = fullscreenRenderer();
		const split = createSplitPaneController();
		split.attach(first, sidebarComponent);
		expect(() => split.attach(second, sidebarComponent)).toThrow("already attached");
		split.dispose();
		expect(() => split.attach(first, sidebarComponent)).toThrow("disposed");
	});
});

describe("unsupported renderers", () => {
	it.each(["regular", "fullscreen"] as const)("fails closed in %s mode", (mode) => {
		const renderer = unknownRenderer(mode);
		const originalRender = renderer.render;
		const originalRoot = (renderer as unknown as { layoutRoot: unknown }).layoutRoot;
		const split = createSplitPaneController();
		split.attach(renderer, sidebarComponent);
		split.show();

		expect(renderer.render).toBe(originalRender);
		expect((renderer as unknown as { layoutRoot: unknown }).layoutRoot).toBe(originalRoot);
		expect(
			(renderer as unknown as { setLayoutRoot: ReturnType<typeof vi.fn> }).setLayoutRoot,
		).not.toHaveBeenCalled();
		expect(split.overlayOptions().visible?.(120, 36)).toBe(false);
		expect(split.isPresented()).toBe(false);
		split.dispose();
	});

	it("keeps the overlay non-capturing and permanently invisible", () => {
		const split = createSplitPaneController();
		expect(split.overlayOptions()).toMatchObject({
			anchor: "top-right",
			width: 44,
			maxHeight: "100%",
			margin: 0,
			nonCapturing: true,
		});
		expect(split.overlayOptions().visible?.(120, 36)).toBe(false);
	});
});
