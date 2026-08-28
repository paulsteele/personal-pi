import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createFooterComponent, renderFooterLine } from "../src/footer.js";
import type { FooterState } from "../src/types.js";

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
	primary: "\u001b[38;2;147;197;253m",
	muted: "\u001b[38;2;128;128;128m",
	dim: "\u001b[38;2;102;102;102m",
	blue: "\u001b[38;2;110;168;254m",
	green: "\u001b[38;2;134;239;172m",
	purple: "\u001b[38;2;177;140;255m",
	cyan: "\u001b[38;2;125;211;252m",
	amber: "\u001b[38;2;255;159;67m",
	red: "\u001b[38;2;255;93;115m",
};

const state: FooterState = {
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
				untrackedFiles: 2,
				linesAdded: 182,
				linesRemoved: 47,
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
	projectName: "repo",
	sessionName: "Sidebar implementation",
	persisted: true,
	branchEntryCount: 38,
};

function plainAt(width: number, renderState: FooterState = state): string {
	return stripAnsi(renderFooterLine(renderState, plainTheme, width));
}

describe("Nerd Font telemetry footer", () => {
	it("renders one dense native strip with all core groups at wide widths", () => {
		const line = plainAt(260);
		for (const marker of [
			"󰒋 gpt-5.6-sol",
			"󰊢 repo · main",
			"󰆍 Sidebar implementation",
			"󰍛 100k [■■■·······] 372k",
			"󰓅 in324k out15k cache5.9M/99% $5.041",
			"󰔟 ~ · ~t/s",
		]) {
			expect(line).toContain(marker);
		}
		expect(line).toContain("182 47 ?2");
		expect(line).not.toContain("ATELIER");
	});

	it("renders response performance in the compact glyph group", () => {
		const line = plainAt(260, { ...state, performance: { ttftMs: 820, tokensPerSecond: 42.34 } });
		expect(line).toContain("󰔟 820ms · 42.3t/s");
	});

	it("keeps activity and context under width pressure", () => {
		for (const width of [56, 40, 28, 20]) {
			const line = plainAt(width);
			expect(line).not.toContain("READY");
			expect(line).toContain("󰍛");
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("progressively compacts and drops optional groups", () => {
		const wide = plainAt(260);
		const medium = plainAt(92);
		const narrow = plainAt(40);
		expect(wide).toContain("OPENAI-CODEX");
		expect(medium).toContain("󰒋 gpt-5.6-sol");
		expect(visibleWidth(medium)).toBeLessThanOrEqual(92);
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(40);
	});

	it("uses fixed semantic colors for primary values and Git churn", () => {
		const line = renderFooterLine(state, namedTheme("dark"), 400);
		expect(line).toContain(`${darkRgb.primary}gpt-5.6-sol\u001b[39m`);
		expect(line).toContain(`${darkRgb.green}182\u001b[39m`);
		expect(line).toContain(`${darkRgb.red}47\u001b[39m`);
		expect(line).toContain(`${darkRgb.blue}■■■\u001b[39m`);
	});

	it("uses the same fixed palette across named themes", () => {
		const dark = renderFooterLine(state, namedTheme("dark"), 300);
		for (const name of ["light", "nord", "solarized"]) {
			expect(renderFooterLine(state, namedTheme(name), 300)).toBe(dark);
		}
	});

	it("uses host theme tokens when color is disabled", () => {
		const fg = vi.fn((_color: string, text: string) => text);
		const disabled = renderFooterLine(
			state,
			{ name: "light", fg, bold: (text) => text, italic: (text) => text },
			260,
			false,
		);
		expect(disabled).not.toContain("\u001b[38;2;");
		expect(fg.mock.calls.map(([color]) => color)).toEqual(
			expect.arrayContaining(["text", "accent", "success", "error"]),
		);
	});

	it("changes the context meter color at warning and danger thresholds", () => {
		const warning = renderFooterLine(
			{ ...state, metrics: { ...state.metrics, contextPercent: 70 } },
			namedTheme("dark"),
			300,
		);
		const danger = renderFooterLine(
			{ ...state, metrics: { ...state.metrics, contextPercent: 90 } },
			namedTheme("dark"),
			300,
		);
		expect(warning).toContain(`${darkRgb.amber}■■■■■■■\u001b[39m`);
		expect(danger).toContain(`${darkRgb.red}■■■■■■■■■\u001b[39m`);
	});

	it("renders unavailable and non-finite telemetry safely", () => {
		const unavailable: FooterState = {
			...state,
			metrics: {
				...state.metrics,
				usageAvailable: false,
				costAvailable: false,
				cacheHitPercent: Number.NaN,
				contextPercent: null,
				cost: Number.NaN,
			},
		};
		const line = plainAt(260, unavailable);
		expect(line).toContain("󰍛 100k [··········] 372k");
		expect(line).toContain("󰓅 in— out— cache—/— $—");
		expect(line).not.toMatch(/NaN|Infinity/);
	});

	it("includes Plan, alert, and contributed summaries at roomy widths", () => {
		const line = plainAt(400, {
			...state,
			plannotatorStatus: "⏸ plan",
			autoModeStatus: "⏵⏵ auto 12/1",
			extensionStatuses: ["sync warning"],
			panelSummaries: [{ id: "vendor:queue", title: "Queue", summary: "2 pending" }],
		});
		for (const text of ["⏸ plan", "⏵⏵ auto 12/1", "󰀦 sync warning", "󰮯 Queue 2 pending"]) {
			expect(line).toContain(text);
		}
	});

	it("keeps armed auto mode and active Plan visible at practical narrow width", () => {
		const line = plainAt(56, { ...state, autoModeStatus: "⏵⏵ auto 12/1", plannotatorStatus: "⏸ plan" });
		expect(line).toContain("⏵⏵ auto");
		expect(line).toContain("⏸ plan");
	});

	it("sanitizes dynamic text and bounds every responsive width", () => {
		const hostile: FooterState = {
			...state,
			modelId: "gpt\n5",
			sessionName: "release\tnow",
			autoModeStatus: "\u001b[31mauto\u001b[0m\nmode",
			panelSummaries: [{ id: "vendor:queue", title: "Queue\nstatus", summary: "2\tpending" }],
		};
		for (const width of [220, 160, 120, 92, 72, 56, 40, 28, 20, 12]) {
			const line = renderFooterLine(hostile, plainTheme, width);
			expect(line).not.toMatch(/[\n\t]/);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("footer component", () => {
	it("stays visible while the sidebar is presented", () => {
		const component = createFooterComponent({
			getState: () => state,
			isSidebarPresented: () => true,
			requestRender: vi.fn(),
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
		});
		expect(component.render(160)).toHaveLength(1);
		component.dispose();
	});

	it("does not animate when activity changes", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const component = createFooterComponent({
			getState: () => ({ ...state, activity: "working" }),
			requestRender,
			onBranchChange: () => vi.fn(),
			theme: plainTheme,
		});
		try {
			expect(component.render(180)[0]).not.toContain("WORKING");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			component.dispose();
			vi.useRealTimers();
		}
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
});
