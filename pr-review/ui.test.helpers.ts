import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface TestComponent {
	render(width: number): string[];
	handleInput?(data: string): void;
	dispose?(): void;
}
/** Models Pi's single editor slot and deferred custom-component mounting, not just a resolving Promise. */
export function uiHarness() {
	const state = {
		active: undefined as TestComponent | undefined,
		factories: 0,
		closes: 0,
		nativeDialogs: [] as string[],
		frames: [] as string[],
	};
	let creating = false;
	const render = () => {
		if (state.active) state.frames.push(state.active.render(120).join("\n"));
	};
	const native = (name: string) => {
		if (creating || state.active) throw new Error(`Native dialog nested inside work spinner: ${name}`);
		state.nativeDialogs.push(name);
	};
	const ui = {
		custom<T>(factory: (...args: any[]) => TestComponent): Promise<T> {
			if (creating || state.active) return Promise.reject(new Error("Nested custom UI"));
			state.factories++;
			return new Promise((resolve, reject) => {
				let mounted: TestComponent | undefined;
				let closed = false;
				const done = (value: T) => {
					if (closed) return;
					closed = true;
					state.closes++;
					if (state.active === mounted) state.active = undefined;
					resolve(value);
					mounted?.dispose?.();
				};
				try {
					creating = true;
					const component = factory(
						{ requestRender: render },
						{ fg: (_color: string, text: string) => text },
						{
							getKeys: () => ["escape"],
							matches: (data: string, key: string) => data === "cancel-key" && key === "tui.select.cancel",
						},
						done,
					);
					creating = false;
					Promise.resolve(component).then((value) => {
						if (!closed) {
							mounted = value;
							state.active = value;
							render();
						}
					});
				} catch (error) {
					creating = false;
					reject(error);
				}
			});
		},
		async select(title: string, options: string[]) {
			native(title);
			return title.startsWith("Activate") ? "Approve" : options[0];
		},
		async confirm(title: string) {
			native(title);
			return false;
		},
		async input(title: string) {
			native(title);
			return "Fixture answer";
		},
		async editor(title: string, prefill: string) {
			native(title);
			return prefill;
		},
		notify() {},
		setStatus() {},
	};
	return { state, ui: ui as unknown as ExtensionContext["ui"] };
}
