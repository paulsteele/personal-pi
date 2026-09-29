import { expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme("dark", false);
import { ArbitrationPanel, reviewText, qualityUI, feedbackRenderer, createCheckingRenderer } from "./ui.js";
import {
	QUALITY_CHECK_ENTRY,
	qualityFeedbackLabel,
	type QualityCheckData,
	type QualityCheckStage,
	type QualityFeedbackDetails,
} from "./feedback.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { newCase } from "./case.js";

function fixture() {
	const state = newCase("/repo", "test/reviewer");
	state.files = [{ path: "/repo/a.ts", before: "", after: "const x = 1;" }];
	state.verdict = {
		verdict: "needs_work",
		rationale: "Name the count",
		findings: [],
		edits: [{ file: "/repo/a.ts", oldText: "const x = 1;", newText: "const count = 1;" }],
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

it.each([
	{ rejectionText: "Name the count\n/repo/a.ts:1 [names] x hides its purpose.", source: "readability" },
	{ rejectionText: "/repo/a.ts:1:1 [typescript/warning] Unused declaration", source: "lsp" },
])("shows $source rejection text without expanding protocol details", ({ rejectionText }) => {
	const message = {
		role: "custom" as const,
		customType: "code-quality:feedback",
		content: "Case case-id; revision snapshot-id; exact proposed edits; Do not self-waive.",
		details: { outcome: "rejected", rejection: 2, rejectionText } satisfies QualityFeedbackDetails,
		display: true,
		timestamp: 0,
	};
	const collapsed = feedbackRenderer(message, { expanded: false, outputPad: 0 }, logTheme)!;
	expect(
		collapsed
			.render(120)
			.map((line) => line.trimEnd())
			.join("\n"),
	).toBe(`handling rejection 2\n${rejectionText}`);
	const expanded = feedbackRenderer(message, { expanded: true, outputPad: 0 }, logTheme)!;
	expect(expanded.render(120).join("\n")).toContain(message.content);
});

it("shows legacy rejection content and strips terminal control sequences", () => {
	const message = {
		role: "custom" as const,
		customType: "code-quality:feedback",
		content: "Reviewer: \u001b[31mName the count\u001b[0m",
		details: { outcome: "rejected", rejection: 1 },
		display: true,
		timestamp: 0,
	};
	const component = feedbackRenderer(message, { expanded: false, outputPad: 0 }, logTheme)!;
	expect(component.render(120).map((line) => line.trimEnd())).toEqual([
		"handling rejection 1",
		"Reviewer: Name the count",
	]);
});

function checkingEntry(data: unknown) {
	return {
		type: "custom" as const,
		customType: QUALITY_CHECK_ENTRY,
		id: "checking",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		data,
	};
}

it.each([
	{ source: "lsp", outcome: undefined, expected: "quality check: lsp" },
	{ source: "readability", outcome: "passed", expected: "quality check: readability ✓" },
	{ source: "lsp", outcome: "failed", expected: "quality check: lsp ✕" },
	{ source: "readability", outcome: "stale", expected: "quality check: readability ✕ (outdated)" },
	{ source: "lsp", outcome: "interrupted", expected: "quality check: lsp ✕ (interrupted)" },
] satisfies Array<QualityCheckStage & { expected: string }>)(
	"renders $expected from persisted stage data",
	({ source, outcome, expected }) => {
		const renderer = createCheckingRenderer(() => undefined);
		const entry = checkingEntry({ checkId: "check-id", caseId: "case-id", stages: [{ source, outcome }] });
		const component = renderer(entry, { expanded: false }, logTheme)!;
		expect(component.render(100).map((line) => line.trimEnd())).toEqual([expected]);
	},
);

it("updates the existing checking component as each stage completes", () => {
	let check: QualityCheckData = { checkId: "check-id", caseId: "case-id", stages: [{ source: "lsp" }] };
	const renderer = createCheckingRenderer((id) => (id === check.checkId ? check : undefined));
	const component = renderer(checkingEntry(check), { expanded: false }, logTheme)!;
	expect(component.render(80).map((line) => line.trimEnd())).toEqual(["quality check: lsp"]);
	check = { ...check, stages: [{ source: "lsp", outcome: "passed" }, { source: "readability" }] };
	expect(component.render(80).map((line) => line.trimEnd())).toEqual([
		"quality check: lsp ✓",
		"quality check: readability",
	]);
	check = {
		...check,
		stages: [
			{ source: "lsp", outcome: "passed" },
			{ source: "readability", outcome: "failed" },
		],
	};
	expect(component.render(80).map((line) => line.trimEnd())).toEqual([
		"quality check: lsp ✓",
		"quality check: readability ✕",
	]);
	for (const width of [12, 35, 80]) {
		for (const line of component.render(width)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	}
});

it.each([
	{ data: { caseId: "case-id" }, expected: "quality check: readability" },
	{ data: { caseId: "case-id", source: "lsp" }, expected: "quality check: lsp" },
])("labels legacy checking entries without inventing a verdict", ({ data, expected }) => {
	const renderer = createCheckingRenderer(() => undefined);
	const component = renderer(checkingEntry(data), { expanded: false }, logTheme)!;
	expect(component.render(80).map((line) => line.trimEnd())).toEqual([expected]);
});

it("does not turn malformed or legacy metadata into an approval", () => {
	expect(qualityFeedbackLabel(undefined)).toBe("quality");
	expect(qualityFeedbackLabel({ outcome: "surprise" })).toBe("quality");
	expect(qualityFeedbackLabel({ outcome: "rejected", rejection: NaN })).toBe("handling rejection");
	expect(qualityFeedbackLabel({ outcome: "rejected", rejection: -1 })).toBe("handling rejection");
});

it("omits accept-proposed when only LSP hints are available", () => {
	const state = newCase("/repo", "test/reviewer");
	state.files = [{ path: "/repo/a.ts", before: "", after: "const unused = 1;" }];
	const lspHint = {
		file: "/repo/a.ts",
		serverId: "typescript",
		severity: 4 as const,
		message: "Unused declaration",
		range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
	};
	state.lsp = {
		findings: [lspHint],
		revision: "r",
		configuration: "c",
		workspaceRevision: 0,
		generation: "g",
	};
	const done = vi.fn();
	const panel = new ArbitrationPanel(
		{ terminal: { rows: 40 }, requestRender() {} } as never,
		{ fg: (_: string, text: string) => text } as never,
		state,
		done,
	);
	expect(panel.render(100).join("\n")).not.toContain("Accept proposed");
	expect(reviewText(state)).toContain("typescript/hint");
	panel.handleInput("\u001b[B");
	panel.handleInput("\r");
	expect(done).toHaveBeenCalledWith({ choice: "continue", note: "" });
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
