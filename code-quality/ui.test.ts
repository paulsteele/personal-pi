import { expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme("dark", false);
import { ArbitrationPanel, reviewText, qualityUI, feedbackRenderer, checkingRenderer } from "./ui.js";
import { QUALITY_CHECK_ENTRY, qualityFeedbackLabel, type QualityFeedbackDetails } from "./feedback.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { newCase } from "./case.js";

function fixture() {
	const state = newCase("/repo", "test/reviewer");
	state.files = [{ path: "/repo/a.ts", before: "", after: "const x = 1;" }];
	state.verdict = {
		verdict: "needs_work",
		rationale: "Name the count",
		findings: [],
		edits: [],
		proposed: { "/repo/a.ts": "const count = 1;" },
	};
	state.objection = "A short name is sufficient";
	const done = vi.fn();
	const tui = { terminal: { rows: 40 }, requestRender: vi.fn() };
	const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text };
	const panel = new ArbitrationPanel(tui as never, theme as never, state, done);
	return { state, done, tui, panel };
}
const logTheme = { fg: (_color: string, text: string) => text } as Theme;

it.each([
	{ details: { outcome: "approved" }, expected: "approved" },
	{ details: { outcome: "rejected", rejection: 1 }, expected: "handling rejection 1" },
	{ details: { outcome: "rejected", rejection: 3 }, expected: "handling rejection 3" },
	{ details: { outcome: "waived" }, expected: "waived" },
] satisfies Array<{ details: QualityFeedbackDetails; expected: string }>)(
	"renders a single compact $expected line while retaining expanded feedback",
	({ details, expected }) => {
		const content =
			'Quality case case-id; revision snapshot-id;\n{"findings":[{"rationale":"Name the count"}]}\nDo not self-waive.';
		const message = {
			role: "custom" as const,
			customType: "code-quality:feedback",
			content,
			details,
			display: true,
			timestamp: 0,
		};
		const collapsed = feedbackRenderer(message, { expanded: false, outputPad: 0 }, logTheme)!;
		expect(collapsed.render(100).map((line) => line.trimEnd())).toEqual([expected]);
		const expanded = feedbackRenderer(message, { expanded: true, outputPad: 0 }, logTheme)!;
		const fullText = expanded.render(120).join("\n");
		expect(fullText).toContain(expected);
		expect(fullText).toContain("case-id");
		expect(fullText).toContain("Name the count");
		expect(message.content).toBe(content);
	},
);

it("shows a compact checking entry without model-facing prose", () => {
	const entry = {
		type: "custom" as const,
		customType: QUALITY_CHECK_ENTRY,
		id: "checking",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		data: { caseId: "case-id" },
	};
	const component = checkingRenderer(entry, { expanded: false }, logTheme)!;
	expect(component.render(80).map((line) => line.trimEnd())).toEqual(["Checking Quality..."]);
});

it("does not turn malformed or legacy metadata into an approval", () => {
	expect(qualityFeedbackLabel(undefined)).toBe("quality");
	expect(qualityFeedbackLabel({ outcome: "surprise" })).toBe("quality");
	expect(qualityFeedbackLabel({ outcome: "rejected", rejection: NaN })).toBe("handling rejection");
	expect(qualityFeedbackLabel({ outcome: "rejected", rejection: -1 })).toBe("handling rejection");
});

it("shows the current/proposed diff and both rationales at narrow widths", () => {
	const h = fixture();
	expect(reviewText(h.state)).toContain("const count = 1;");
	expect(reviewText(h.state)).toContain("Agent disagreement");
	for (const width of [35, 80, 120])
		for (const line of h.panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});
it.each([0, 1, 2])("resolves choice %s with one Enter and no notes prompt", (selected) => {
	const h = fixture();
	for (let i = 0; i < selected; i++) h.panel.handleInput("\u001b[B");
	expect(h.done).not.toHaveBeenCalled();
	h.panel.handleInput("\r");
	expect(h.done).toHaveBeenCalledExactlyOnceWith({
		choice: ["original", "proposed", "continue"][selected],
		note: "",
	});
});

it.each([0, 1, 2])(
	"opens optional notes with n and resolves choice %s when notes are submitted",
	(selected) => {
		const h = fixture();
		h.panel.focused = true;
		for (let i = 0; i < selected; i++) h.panel.handleInput("\u001b[B");
		h.panel.handleInput("n");
		for (const char of "case note") h.panel.handleInput(char);
		expect(h.done).not.toHaveBeenCalled();
		expect(h.panel.render(100).join("\n")).toContain("enter save & resolve");
		h.panel.handleInput("\r");
		expect(h.done).toHaveBeenCalledExactlyOnceWith({
			choice: ["original", "proposed", "continue"][selected],
			note: "case note",
		});
	},
);

it("submits empty optional notes without a confirmation screen", () => {
	const h = fixture();
	h.panel.handleInput("n");
	h.panel.handleInput("\r");
	expect(h.done).toHaveBeenCalledExactlyOnceWith({ choice: "original", note: "" });
});

it("keeps n as note text and Shift+Enter as a newline while editing", () => {
	const h = fixture();
	h.panel.focused = true;
	h.panel.handleInput("\u001b[B");
	h.panel.handleInput("n");
	for (const char of "name") h.panel.handleInput(char);
	h.panel.handleInput("\u001b[13;2u");
	for (const char of "next") h.panel.handleInput(char);
	expect(h.done).not.toHaveBeenCalled();
	h.panel.handleInput("\r");
	expect(h.done).toHaveBeenCalledExactlyOnceWith({ choice: "proposed", note: "name\nnext" });
});

it("Escape while writing notes cancels without submitting the selected choice", () => {
	const h = fixture();
	h.panel.handleInput("\u001b[B");
	h.panel.handleInput("n");
	for (const char of "unfinished") h.panel.handleInput(char);
	h.panel.handleInput("\u001b");
	expect(h.done).toHaveBeenCalledExactlyOnceWith(undefined);
});

it("shows direct-resolution and optional-notes shortcuts without a confirmation hint", () => {
	const h = fixture();
	const text = h.panel.render(100).join("\n");
	expect(text).toContain("enter resolve");
	expect(text).toContain("n add notes");
	expect(text).not.toContain("confirm");
});
it("escape never approves and cancellation disposes the pending panel", async () => {
	const h = fixture();
	h.panel.handleInput("\u001b");
	expect(h.done).toHaveBeenCalledWith(undefined);
	const controller = new AbortController();
	const ctx = {
		ui: {
			custom: (factory: Function) =>
				new Promise((resolve) => {
					factory(h.tui, { fg: (_: string, value: string) => value }, {}, resolve);
				}),
		},
	};
	const pending = qualityUI.arbitrate(ctx as never, h.state, controller.signal);
	controller.abort();
	expect(await pending).toBeUndefined();
});
