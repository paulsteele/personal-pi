import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export class ReviewCancelled extends Error {
	constructor() {
		super("Review cancelled");
	}
}
export async function chooseMany(
	ctx: ExtensionContext,
	title: string,
	items: Array<{ id: string; label: string }>,
	signal: AbortSignal,
	initial: string[] = [],
	max = items.length,
): Promise<string[]> {
	const selected = new Set(initial);
	for (;;) {
		signal.throwIfAborted();
		const labels = items.map((item) => `${selected.has(item.id) ? "[x]" : "[ ]"} ${item.label}`);
		const choice = await ctx.ui.select(
			`${title} (${selected.size} selected)`,
			["Continue", ...labels, "Cancel"],
			{ signal },
		);
		if (choice === undefined || choice === "Cancel") throw new ReviewCancelled();
		if (choice === "Continue") {
			if (selected.size <= max) return [...selected];
			ctx.ui.notify(`Select no more than ${max}; none will be silently omitted.`, "warning");
			continue;
		}
		const item = items[labels.indexOf(choice)];
		if (item) {
			if (selected.has(item.id)) selected.delete(item.id);
			else selected.add(item.id);
		}
	}
}
