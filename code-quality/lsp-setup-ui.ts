import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";

export interface LspLanguageChoice {
	id: string;
	label: string;
	description: string;
	selected: boolean;
}
export interface LspLanguageSelection {
	action: "continue" | "advanced";
	selected: string[];
}

export async function selectLspLanguages(
	ctx: ExtensionContext,
	choices: LspLanguageChoice[],
	signal: AbortSignal,
): Promise<LspLanguageSelection | undefined> {
	if (signal.aborted) {
		return undefined;
	}
	return ctx.ui.custom<LspLanguageSelection | undefined>((tui, theme, _keys, done) => {
		const selected = new Set(choices.filter((choice) => choice.selected).map((choice) => choice.id));
		let settled = false;
		const finish = (selection: LspLanguageSelection | undefined) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			done(selection);
		};
		const abort = () => finish(undefined);
		const header = new Text(theme.fg("accent", "LSP setup — choose languages to check"), 0, 0);
		const footer = new Text("↑/↓ move · space/enter toggle · esc cancel", 0, 0);
		const makeList = (index = 0): SelectList => {
			const list = new SelectList(
				[
					...choices.map((choice) => ({
						value: choice.id,
						label: `${selected.has(choice.id) ? "[x]" : "[ ]"} ${choice.label}`,
						description: choice.description,
					})),
					{
						value: "continue",
						label: "Continue",
						description: "Review selected languages, then validate and enable",
					},
					{
						value: "advanced",
						label: "Advanced",
						description: "Executable paths, custom servers, roots, and configuration",
					},
					{ value: "cancel", label: "Cancel" },
				],
				10,
				{
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("muted", text),
					noMatch: (text) => theme.fg("warning", text),
				},
			);
			list.setSelectedIndex(index);
			list.onCancel = abort;
			list.onSelect = ({ value }) => {
				if (value === "cancel") {
					abort();
					return;
				}
				if (value === "continue" || value === "advanced") {
					finish({ action: value, selected: [...selected] });
					return;
				}
				if (selected.has(value)) {
					selected.delete(value);
				} else {
					selected.add(value);
				}
				languageList = makeList(choices.findIndex((choice) => choice.id === value));
				tui.requestRender();
			};
			return list;
		};
		let languageList = makeList();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) queueMicrotask(abort);
		return {
			render: (width) => [
				...header.render(width),
				"",
				...languageList.render(width),
				"",
				...footer.render(width),
			],
			invalidate() {
				header.invalidate();
				footer.invalidate();
				languageList.invalidate();
			},
			handleInput(data) {
				const item = languageList.getSelectedItem();
				if (matchesKey(data, Key.space) && item && choices.some((choice) => choice.id === item.value)) {
					languageList.onSelect?.(item);
				} else {
					languageList.handleInput(data);
				}
				tui.requestRender();
			},
			dispose: () => signal.removeEventListener("abort", abort),
		};
	});
}
