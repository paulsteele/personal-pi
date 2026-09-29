import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { selectLspLanguages, type LspLanguageChoice, type LspLanguageSelection } from "./lsp-setup-ui.js";

const choices: LspLanguageChoice[] = [
	{ id: "typescript", label: "TypeScript / JavaScript", description: "Detected", selected: true },
	{ id: "pyright", label: "Python", description: "Detected", selected: true },
];

function pickerFixture() {
	let component!: Component;
	let finish!: (result: LspLanguageSelection | undefined) => void;
	const result = new Promise<LspLanguageSelection | undefined>((resolve) => {
		finish = resolve;
	});
	const theme = { fg: (_color: string, text: string) => text } as Theme;
	const ctx = {
		ui: {
			custom: vi.fn((factory) => {
				component = factory({ requestRender() {} }, theme, {}, finish);
				return result;
			}),
		},
	} as unknown as ExtensionContext;
	return { ctx, result, component: () => component };
}

it("toggles languages in one checklist and submits the selected set", async () => {
	const fixture = pickerFixture();
	const pending = selectLspLanguages(fixture.ctx, choices, new AbortController().signal);
	const picker = fixture.component();
	expect(picker.render(80).join("\n")).toContain("[x] Python");
	picker.handleInput?.("\u001b[B");
	picker.handleInput?.(" ");
	expect(picker.render(80).join("\n")).toContain("[ ] Python");
	picker.handleInput?.("\u001b[B");
	picker.handleInput?.("\r");
	expect(await pending).toEqual({ action: "continue", selected: ["typescript"] });
});

it("opens Advanced with the current selections and fits narrow terminals", async () => {
	const fixture = pickerFixture();
	const pending = selectLspLanguages(fixture.ctx, choices, new AbortController().signal);
	const picker = fixture.component();
	for (const width of [20, 40, 80]) {
		for (const line of picker.render(width)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	}
	for (let row = 0; row < 3; row++) {
		picker.handleInput?.("\u001b[B");
	}
	picker.handleInput?.("\r");
	expect(await pending).toEqual({ action: "advanced", selected: ["typescript", "pyright"] });
});

it.each(["escape", "abort"])("cancels without a selection on %s", async (action) => {
	const fixture = pickerFixture();
	const cancellation = new AbortController();
	const pending = selectLspLanguages(fixture.ctx, choices, cancellation.signal);
	if (action === "escape") {
		fixture.component().handleInput?.("\u001b");
	} else {
		cancellation.abort();
	}
	expect(await pending).toBeUndefined();
});
