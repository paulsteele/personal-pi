import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createFooterComponent, renderFooterLine } from "../src/footer.js";
import type { AtelierState } from "../src/types.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

const namedTheme = (name: string) => ({
	name,
	fg: (color: string, text: string) => `<${name}:${color}>${text}</${name}:${color}>`,
	bold: (text: string) => text,
	italic: (text: string) => text,
});

const darkRgb = {
	text: "\u001b[38;2;212;212;212m",
	muted: "\u001b[38;2;128;128;128m",
	dim: "\u001b[38;2;102;102;102m",
	blue: "\u001b[38;2;110;168;254m",
	purple: "\u001b[38;2;177;140;255m",
	cyan: "\u001b[38;2;125;211;252m",
	amber: "\u001b[38;2;255;159;67m",
	red: "\u001b[38;2;255;93;115m",
};

function plainAt(width: number, renderState = state): string {
	return stripAnsi(renderFooterLine(renderState, plainTheme, width));
}

function firstWidthWithout(text: string, renderState = state): number {
	for (let width = 220; width >= 20; width -= 1) {
		if (!plainAt(width, renderState).includes(text)) return width;
	}
	throw new Error(`Expected ${text} to be removed`);
}

const state: AtelierState = {
	activity: "ready",
	modelId: "gpt-5.6-sol",
	provider: "openai-codex",
	thinkingLevel: "medium",
	branch: "main",
	dirty: true,
	workspacePulse: {
		status: "changed",
		data: {
			root: "/repo",
			relativeCwd: "",
			branch: "main",
			snapshot: {
				trackedFiles: 1,
				untrackedFiles: 0,
				linesAdded: 1,
				linesRemoved: 0,
				binaryFiles: 0,
				submodules: 0,
				conflicts: 0,
			},
		},
	},
	metrics: {
		usageAvailable: true,
		costAvailable: true,
		input: 324_000,
		output: 15_000,
		cacheRead: 5_900_000,
		cacheWrite: 0,
		cacheHitPercent: 98.8,
		cost: 5.041,
		subscription: true,
		contextTokens: 100_000,
		contextWindow: 372_000,
		contextPercent: 27,
		autoCompact: true,
	},
	extensionStatuses: [],
};

describe("footer performance", () => {
	it("is part of the fixed dense rail", () => {
		const idle = stripAnsi(renderFooterLine(state, plainTheme, 220));
		expect(idle).toContain("TTFT ~ · TPS ~");
		const measured = stripAnsi(
			renderFooterLine(
				{ ...state, performance: { ttftMs: 820, tokensPerSecond: 42.34, estimated: true } },
				plainTheme,
				220,
			),
		);
		expect(measured).toContain("TTFT 820ms · TPS ~42.3");
	});

	it("keeps performance labels muted and dims unmeasured values", () => {
		const idle = renderFooterLine(state, namedTheme("dark"), 400);
		expect(idle).toContain(`${darkRgb.muted}TTFT\u001b[39m ${darkRgb.dim}~\u001b[39m`);
		expect(idle).toContain(`${darkRgb.muted}TPS\u001b[39m ${darkRgb.dim}~\u001b[39m`);
		const measured = renderFooterLine(
			{ ...state, performance: { ttftMs: 820, tokensPerSecond: 42.34 } },
			namedTheme("dark"),
			400,
		);
		expect(measured).toContain(`${darkRgb.muted}TTFT\u001b[39m ${darkRgb.purple}820ms\u001b[39m`);
		expect(measured).toContain(`${darkRgb.muted}TPS\u001b[39m ${darkRgb.purple}42.3\u001b[39m`);
	});

	it("drops performance as one optional item under width pressure", () => {
		const line = stripAnsi(
			renderFooterLine({ ...state, performance: { ttftMs: 820, tokensPerSecond: 42.34 } }, plainTheme, 56),
		);
		expect(line).not.toContain("TTFT");
	});
});

describe("footer", () => {
	it("renders a quiet two-zone Status Rail at wide widths", () => {
		const line = stripAnsi(renderFooterLine(state, plainTheme, 160));
		expect(line).toContain("● READY · gpt-5.6-sol · medium · main*");
		for (const text of ["in 324k", "out 15k", "cache 99%", "$5.041 (sub)", "ctx 27.0%"]) {
			expect(line).toContain(text);
		}
		expect(line).not.toMatch(/ATELIER|R5\.9M|CH98\.8|◔|✦|MENU/);
		expect(visibleWidth(line)).toBe(160);
	});

	it("right-aligns readable telemetry", () => {
		const line = stripAnsi(renderFooterLine(state, plainTheme, 180));
		expect(line.endsWith("ctx 27.0% (auto)")).toBe(true);
		expect(line.indexOf("● READY")).toBe(0);
		expect(line.indexOf("in 324k")).toBeGreaterThan(line.indexOf("main*"));
	});

	it("removes optional information in the approved order", () => {
		const gitAndThinkingGone = Math.min(firstWidthWithout("main*"), firstWidthWithout("medium"));
		const costGone = firstWidthWithout("$5.041");
		const modelGone = firstWidthWithout("gpt-5.6-sol");
		const inputAndOutputGone = Math.min(firstWidthWithout("in 324k"), firstWidthWithout("out 15k"));
		const cacheGone = firstWidthWithout("cache 99%");
		expect(gitAndThinkingGone).toBeGreaterThan(costGone);
		expect(costGone).toBeGreaterThan(modelGone);
		expect(modelGone).toBeGreaterThan(inputAndOutputGone);
		expect(inputAndOutputGone).toBeGreaterThan(cacheGone);
	});

	it("keeps activity and context after optional information is removed", () => {
		const line = plainAt(24);
		expect(line).toContain("● READY");
		expect(line).toContain("ctx");
		expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});

	it("never introduces old cryptic compact labels", () => {
		for (const width of [180, 132, 96, 72, 56, 40, 24]) {
			expect(plainAt(width)).not.toMatch(/(?:^|\s)(?:R|W|CH)\d|◔/);
		}
	});

	it("uses fixed dark colors for named custom themes", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const line = renderFooterLine(
			state,
			{ name: "nord", fg, bold: (text) => text, italic: (text) => text },
			180,
		);
		expect(line).toContain(`${darkRgb.muted}in\u001b[39m ${darkRgb.blue}324k\u001b[39m`);
		expect(line).toContain(`${darkRgb.muted}cache\u001b[39m ${darkRgb.cyan}99%\u001b[39m`);
		expect(fg).not.toHaveBeenCalled();
	});

	it("colors dark-theme values while keeping labels muted", () => {
		const line = renderFooterLine(state, namedTheme("dark"), 400);
		expect(line).toContain(`${darkRgb.muted}in\u001b[39m ${darkRgb.blue}324k\u001b[39m`);
		expect(line).toContain(`${darkRgb.muted}out\u001b[39m ${darkRgb.purple}15k\u001b[39m`);
		expect(line).toContain(`${darkRgb.muted}cache\u001b[39m ${darkRgb.cyan}99%\u001b[39m`);
		expect(line).toContain(`${darkRgb.amber}$5.041\u001b[39m${darkRgb.muted} (sub)\u001b[39m`);
		expect(line).toContain(`${darkRgb.muted}ctx\u001b[39m ${darkRgb.blue}27.0%\u001b[39m`);
	});

	it("renders the selected light theme with the same fixed dark palette", () => {
		const light = renderFooterLine(state, namedTheme("light"), 400);
		const dark = renderFooterLine(state, namedTheme("dark"), 400);
		expect(light).toBe(dark);
		expect(light).toContain(`${darkRgb.blue}324k\u001b[39m`);
		expect(light).toContain(`${darkRgb.purple}15k\u001b[39m`);
		expect(light).toContain(`${darkRgb.cyan}99%\u001b[39m`);
		expect(light).toContain(`${darkRgb.amber}$5.041\u001b[39m`);
		expect(light).toContain(`${darkRgb.blue}27.0%\u001b[39m`);
	});

	it("uses state-specific activity colors", () => {
		const ready = renderFooterLine(state, namedTheme("dark"), 180);
		const working = renderFooterLine(
			{ ...state, activity: "working", workingLabel: "PONDERING" },
			namedTheme("dark"),
			180,
		);
		expect(ready).toContain(`${darkRgb.blue}● READY\u001b[39m`);
		expect(working).toContain(`${darkRgb.amber}● PONDERING...\u001b[39m`);
	});

	it("overrides context blue at warning and danger thresholds", () => {
		const warning = renderFooterLine(
			{ ...state, metrics: { ...state.metrics, contextPercent: 70 } },
			namedTheme("dark"),
			180,
		);
		const danger = renderFooterLine(
			{ ...state, metrics: { ...state.metrics, contextPercent: 90 } },
			namedTheme("dark"),
			180,
		);
		expect(warning).toContain(`${darkRgb.amber}70.0%\u001b[39m`);
		expect(danger).toContain(`${darkRgb.red}90.0%\u001b[39m`);
		const lightDanger = renderFooterLine(
			{ ...state, metrics: { ...state.metrics, contextPercent: 90 } },
			namedTheme("light"),
			180,
		);
		expect(lightDanger).toContain(`${darkRgb.red}90.0%\u001b[39m`);
	});

	it("keeps unavailable values dim instead of category-colored", () => {
		const line = renderFooterLine(
			{
				...state,
				metrics: {
					...state.metrics,
					usageAvailable: false,
					costAvailable: false,
					contextPercent: null,
				},
			},
			namedTheme("dark"),
			400,
		);
		expect(line).toContain(`${darkRgb.dim}—\u001b[39m`);
		expect(line).toContain(`${darkRgb.dim}$—\u001b[39m`);
		for (const category of [darkRgb.blue, darkRgb.purple, darkRgb.cyan, darkRgb.amber, darkRgb.red]) {
			expect(line).not.toContain(`${category}—`);
			expect(line).not.toContain(`${category}$—`);
		}
	});

	it("does not request warning or error roles for a clean ready state", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		renderFooterLine({ ...state, dirty: false }, { fg, bold: (text) => text, italic: (text) => text }, 180);
		const colors = fg.mock.calls.map(([color]) => color);
		expect(colors).not.toContain("warning");
		expect(colors).not.toContain("error");
	});

	it("uses warning and error only for actionable states", () => {
		for (const [percent, color] of [
			[70, "warning"],
			[90, "error"],
		] as const) {
			const fg = vi.fn((_color: string, text: string) => text);
			renderFooterLine(
				{ ...state, metrics: { ...state.metrics, contextPercent: percent } },
				{ fg, bold: (text) => text, italic: (text) => text },
				160,
			);
			expect(fg).toHaveBeenCalledWith(color, `${percent.toFixed(1)}%`);
		}
	});

	it("uses the same semantic hierarchy without custom RGB when color is disabled", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const disabled = renderFooterLine(
			state,
			{ name: "light", fg, bold: (text) => text, italic: (text) => text },
			180,
			false,
		);
		const colored = renderFooterLine(state, namedTheme("light"), 180, true);
		expect(stripAnsi(disabled)).toBe(stripAnsi(colored));
		expect(disabled).not.toContain("\u001b[38;2;");
		expect(fg.mock.calls.map(([color]) => color)).toEqual(
			expect.arrayContaining(["text", "muted", "warning"]),
		);
	});

	it("keeps ANSI-heavy themed output within every responsive width", () => {
		const ansiTheme = {
			fg: (_color: string, text: string) => `\u001b[38;5;45m${text}\u001b[0m`,
			bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
			italic: (text: string) => `\u001b[3m${text}\u001b[23m`,
		};
		for (const width of [132, 131, 96, 95, 72, 71, 56, 55, 20]) {
			expect(visibleWidth(renderFooterLine(state, ansiTheme, width))).toBeLessThanOrEqual(width);
		}
	});

	it("renders identically across selected themes at representative widths", () => {
		for (const width of [160, 100, 56, 20]) {
			const dark = renderFooterLine(state, namedTheme("dark"), width);
			for (const selectedTheme of ["light", "nord", "solarized"]) {
				expect(renderFooterLine(state, namedTheme(selectedTheme), width)).toBe(dark);
			}
			expect(visibleWidth(dark)).toBeLessThanOrEqual(width);
			expect(stripAnsi(dark)).toContain(width >= 56 ? "ctx" : "● READY");
		}
	});

	it.each([160, 100, 80, 56, 40, 12])("never exceeds width %d", (width) => {
		expect(visibleWidth(renderFooterLine(state, plainTheme, width))).toBeLessThanOrEqual(width);
	});

	it("keeps required activity and context at the supported narrow boundary", () => {
		const line = renderFooterLine(state, plainTheme, 56);
		expect(line).toContain("● READY");
		expect(line).toContain("ctx 27.0%");
		expect(line).not.toContain("ATELIER");
	});

	it("keeps extreme numeric telemetry within the requested width", () => {
		const extreme = {
			...state,
			metrics: {
				...state.metrics,
				input: Number.MAX_VALUE,
				output: Number.MAX_SAFE_INTEGER,
				cacheRead: Number.MAX_VALUE,
				cacheWrite: Number.MAX_VALUE,
				cost: Number.MAX_VALUE,
				contextPercent: Number.MAX_VALUE,
			},
		};
		for (const width of [180, 96, 56, 24, 12]) {
			expect(visibleWidth(renderFooterLine(extreme, plainTheme, width))).toBeLessThanOrEqual(width);
		}
		const narrow = renderFooterLine(extreme, plainTheme, 40);
		expect(narrow).toContain("● READY");
		expect(narrow).toContain("ctx");
	});

	it("renders unavailable and non-finite telemetry safely", () => {
		const { cacheHitPercent: _cacheHitPercent, ...metricsWithoutHit } = state.metrics;
		const unavailableState: AtelierState = {
			...state,
			metrics: {
				...metricsWithoutHit,
				usageAvailable: false,
				costAvailable: false,
				contextPercent: null,
				autoCompact: null,
			},
		};
		const unavailableLine = renderFooterLine(unavailableState, plainTheme, 160);
		for (const marker of ["in —", "out —", "cache —", "$—", "ctx —"]) {
			expect(unavailableLine).toContain(marker);
		}
		const invalidLine = renderFooterLine(
			{
				...state,
				metrics: {
					...state.metrics,
					cacheHitPercent: Number.NaN,
					contextPercent: Number.POSITIVE_INFINITY,
					cost: Number.NaN,
				},
			},
			plainTheme,
			160,
		);
		expect(invalidLine).not.toMatch(/NaN|Infinity/);
	});

	it("sanitizes optional text and drops oversized statuses before state or telemetry", () => {
		const sanitized = renderFooterLine(
			{
				...state,
				modelId: "gpt\n5",
				thinkingLevel: "high\tnow",
				branch: "feature\nrail",
				extensionStatuses: ["workflow:\nrunning\t now"],
			},
			plainTheme,
			180,
		);
		for (const text of ["gpt 5", "high now", "feature rail*", "workflow: running now"]) {
			expect(sanitized).toContain(text);
		}
		expect(sanitized).not.toMatch(/[\n\t]/);

		const oversized = renderFooterLine({ ...state, extensionStatuses: ["x".repeat(200)] }, plainTheme, 160);
		expect(oversized).toContain("● READY");
		expect(oversized).toContain("ctx 27.0%");
		expect(oversized).not.toContain("xxxxxxxxxx");
	});

	it("reserves ellipsis width so animated frames never move the model", () => {
		const working = { ...state, activity: "working" as const, workingLabel: "CLAUDING" };
		const lines = ["...", "..", "."].map((dots) =>
			stripAnsi(renderFooterLine(working, plainTheme, 160, true, dots)),
		);
		const modelColumns = lines.map((line) => line.indexOf("gpt-5.6-sol"));
		expect(new Set(modelColumns).size).toBe(1);
		expect(lines[0]).toContain("CLAUDING... · gpt-5.6-sol");
		expect(lines[1]).toContain("CLAUDING..  · gpt-5.6-sol");
		expect(lines[2]).toContain("CLAUDING.   · gpt-5.6-sol");
	});

	it("animates shrinking dots every 400 ms while retaining the selected phrase", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const working = { ...state, activity: "working" as const, workingLabel: "PHOTOSYNTHESIZING" };
		const component = createFooterComponent({
			getState: () => working,
			requestRender,
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
		});

		try {
			expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING...");
			expect(vi.getTimerCount()).toBe(1);
			vi.advanceTimersByTime(400);
			expect(requestRender).toHaveBeenCalledTimes(1);
			expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING..");
			vi.advanceTimersByTime(400);
			expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING.");
			vi.advanceTimersByTime(400);
			expect(component.render(160)[0]).toContain("PHOTOSYNTHESIZING...");
			expect(component.render(160)[0]).not.toContain("WORKING");
		} finally {
			component.dispose();
			vi.useRealTimers();
		}
	});

	it("animates only when the full working status is visible and resets after stopping", () => {
		vi.useFakeTimers();
		let current: AtelierState = { ...state, activity: "working", workingLabel: "PONDERING" };
		const requestRender = vi.fn();
		const component = createFooterComponent({
			getState: () => current,
			requestRender,
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
		});
		try {
			expect(component.render(20)[0]).not.toContain("PONDERING");
			expect(vi.getTimerCount()).toBe(0);
			expect(component.render(100)[0]).toContain("PONDERING...");
			expect(vi.getTimerCount()).toBe(1);
			vi.advanceTimersByTime(400);
			expect(component.render(100)[0]).toContain("PONDERING..");
			current = { ...state, activity: "ready" };
			expect(component.render(100)[0]).toContain("READY");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			component.dispose();
			vi.useRealTimers();
		}
	});

	it("renders the full working phrase and dots in fixed amber for custom themes", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const bold = vi.fn((text: string) => `<b>${text}</b>`);
		const italic = vi.fn((text: string) => `<i>${text}</i>`);
		const working = { ...state, activity: "working" as const, workingLabel: "PONDERING" };
		const line = renderFooterLine(working, { name: "nord", fg, bold, italic }, 160, true, "..");

		expect(line).toContain(`${darkRgb.amber}<b>● PONDERING.. </b>\u001b[39m`);
		expect(fg).not.toHaveBeenCalled();
		expect(italic).not.toHaveBeenCalled();
	});

	it.each([
		["ready", "READY"],
		["working", "WORKING"],
	] as const)("renders %s with the expected fallback label", (activity, expected) => {
		const line = renderFooterLine({ ...state, activity }, plainTheme, 160);
		expect(line).toContain(activity === "working" ? `${expected}...` : expected);
	});

	it("keeps the longest working phrase within responsive width limits", () => {
		const working = { ...state, activity: "working" as const, workingLabel: "PHOTOSYNTHESIZING" };
		for (const width of [132, 131, 96, 95, 72, 71, 56, 55, 20]) {
			expect(visibleWidth(renderFooterLine(working, plainTheme, width))).toBeLessThanOrEqual(width);
		}
	});

	it("renders no footer lines while the sidebar is presented", () => {
		let presented = true;
		const component = createFooterComponent({
			getState: () => state,
			isSidebarPresented: () => presented,
			requestRender: vi.fn(),
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
		});
		expect(component.render(160)).toEqual([]);
		presented = false;
		expect(component.render(160)).toHaveLength(1);
		component.dispose();
	});

	it("keeps Plannotator status under narrow width pressure", () => {
		const planning = { ...state, plannotatorStatus: "⏸ plan" };
		expect(renderFooterLine(planning, plainTheme, 160)).toContain("⏸ plan");
		expect(renderFooterLine(planning, plainTheme, 20)).toContain("⏸ plan");
	});

	it("disposes its branch subscription exactly once", () => {
		const unsubscribe = vi.fn();
		let callback: (() => void) | undefined;
		const requestRender = vi.fn();
		const component = createFooterComponent({
			getState: () => state,
			requestRender,
			onBranchChange: (listener) => {
				callback = listener;
				return unsubscribe;
			},
			theme: plainTheme,
		});
		callback?.();
		expect(requestRender).toHaveBeenCalledOnce();
		component.dispose();
		component.dispose();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("does not restart animation when rendered after disposal", () => {
		vi.useFakeTimers();
		const component = createFooterComponent({
			getState: () => ({ ...state, activity: "working", workingLabel: "PONDERING" }),
			requestRender: vi.fn(),
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
		});

		try {
			component.dispose();
			expect(component.render(160)[0]).toContain("PONDERING...");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			component.dispose();
			vi.useRealTimers();
		}
	});

	it("clears the animation timer and prevents redraws after disposal", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const component = createFooterComponent({
			getState: () => ({ ...state, activity: "working", workingLabel: "PONDERING" }),
			requestRender,
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
		});

		try {
			component.render(160);
			expect(vi.getTimerCount()).toBe(1);
			component.dispose();
			expect(vi.getTimerCount()).toBe(0);
			vi.advanceTimersByTime(800);
			expect(requestRender).not.toHaveBeenCalled();
			component.dispose();
		} finally {
			component.dispose();
			vi.useRealTimers();
		}
	});
});
