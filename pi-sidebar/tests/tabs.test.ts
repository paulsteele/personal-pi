import { expect, it, vi } from "vitest";
import {
	Container,
	ScrollView,
	stripTerminalSequences,
	TuiAltScreen,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { createSplitPaneController } from "../src/split-pane.js";
import { EMPTY_RUN_ACTIVITY } from "../src/run-activity.js";
import {
	buildSidebarSnapshot,
	createSidebarComponent,
	renderSandboxContent,
	renderSummaryContent,
	renderTasksContent,
	SIDEBAR_TAB_ICONS,
	type SidebarTab,
} from "../src/sidebar.js";
import { createInertAtelierState } from "../src/state.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};

it("pins sandbox and turn headers above selectable tool, summary, and sandbox content", () => {
	let tab: SidebarTab = "tools";
	const snapshot = buildSidebarSnapshot({
		state: createInertAtelierState(),
		cwd: "/repo",
		branchEntryCount: 0,
		extensionStatuses: [],
		progressObserver: {
			phase: "ready",
			modelId: "observer",
			summary: { goal: "Ship summary", current: "Implement tabs", progress: "In progress" },
		},
		sandbox: {
			sessionId: "session",
			revision: 1,
			phase: "ready",
			definitionPath: "/private/devcontainer.json",
			cwd: "/repo",
			mounts: [{ source: "/host/repo", destination: "/repo", access: "rw" }],
			ports: [3000],
		},
	});
	const component = createSidebarComponent({
		getSnapshot: () => snapshot,
		getHeight: () => 32,
		getTab: () => tab,
		setTab: (next) => {
			tab = next;
		},
		theme,
	});
	const tools = component.render(44).join("\n");
	expect(tools.indexOf("sandbox · ready")).toBeLessThan(tools.indexOf(SIDEBAR_TAB_ICONS.tools));
	expect(tools).not.toContain("Ship summary");
	tab = "summary";
	expect(component.render(44).join("\n")).toContain("Ship summary");
	tab = "sandbox";
	const sandbox = component.render(44).join("\n");
	expect(sandbox).toContain("[rw] /host/repo");
	expect(sandbox).toContain("CONFIGURATION");
	expect(sandbox).toContain("/private/devcontainer.json");
	expect(sandbox).toContain("Loopback ports");
	expect(sandbox).toContain("127.0.0.1:3000");
});

it("gives full-height summary fields space and wraps every value at narrow widths", () => {
	const snapshot = buildSidebarSnapshot({
		state: createInertAtelierState(),
		cwd: "/repo",
		branchEntryCount: 0,
		extensionStatuses: [],
		progressObserver: {
			phase: "ready",
			modelId: "observer",
			stale: true,
			summary: {
				current: "Implement settings navigation",
				next: "Verify the complete summary remains readable",
				goal: "Ship the sidebar",
				progress: "Settings grouped",
				blockers: "Waiting for review",
			},
		},
	});
	const rows = renderSummaryContent(snapshot, theme, 26, false);
	expect(rows).toContain("NOW");
	expect(rows).toContain("NEXT");
	expect(rows).toContain("BLOCKERS");
	expect(rows.slice(rows.indexOf("NOW") + 1, rows.indexOf("NEXT")).filter((row) => !row.trim())).toHaveLength(
		2,
	);
	expect(rows.join(" ")).toContain("ready · stale");
	expect(rows.join(" ")).toContain("Settings grouped");
	for (const row of rows) {
		expect(visibleWidth(row)).toBeLessThanOrEqual(26);
	}
});

it("styles sandbox details in separate runtime, configuration, mount, network, and error sections", () => {
	const rows = renderSandboxContent(
		{
			sessionId: "session",
			revision: 1,
			phase: "unavailable",
			definitionPath: "/private/devcontainer.json",
			containerName: "pi-app-session-g2",
			containerId: "container-123",
			image: "debian",
			cwd: "/workspace",
			mounts: [{ source: "/host/app", destination: "/workspace", access: "ro" }],
			ports: [3000],
			error: "Image build failed",
		},
		theme,
		26,
		false,
	);
	const rendered = rows.join("\n");
	for (const heading of ["RUNTIME", "CONFIGURATION", "BIND MOUNTS", "NETWORK", "ATTENTION"]) {
		expect(rendered).toContain(heading);
	}
	expect(rendered).toContain("[ro] /host/app");
	expect(rendered).toContain("127.0.0.1:3000");
	expect(rendered).toContain("Image build failed");
	expect(rendered).toContain("container-123");
	for (const row of rows) {
		expect(visibleWidth(row)).toBeLessThanOrEqual(26);
	}
});

it("bounds empty Summary and Sandbox states even in tiny widths", () => {
	const snapshot = buildSidebarSnapshot({
		state: createInertAtelierState(),
		cwd: "/repo",
		branchEntryCount: 0,
		extensionStatuses: [],
	});
	for (const width of [0, 1, 12, 26]) {
		for (const row of [
			...renderSummaryContent(snapshot, theme, width, false),
			...renderSandboxContent(undefined, theme, width, false),
		]) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	}
});

it("bounds Sidebar measurement when the sandbox tab contains long mount details", () => {
	const viewportRows = 20;
	const snapshot = buildSidebarSnapshot({
		state: createInertAtelierState(),
		cwd: "/repo",
		branchEntryCount: 0,
		extensionStatuses: [],
		sandbox: {
			sessionId: "session",
			revision: 1,
			phase: "ready",
			definitionPath: "/private/devcontainer.json",
			mounts: Array.from({ length: 100 }, (_, index) => ({
				source: `/host/${index}/${"project/".repeat(20)}`,
				destination: `/guest/${index}`,
				access: "rw" as const,
			})),
			ports: [],
		},
	});
	const component = createSidebarComponent({
		getSnapshot: () => snapshot,
		getHeight: () => viewportRows,
		getTab: () => "sandbox",
		theme,
	});
	expect(component.render(44)).toHaveLength(viewportRows);
});

function isTabSelectorRow(line: string): boolean {
	const content = line.replace(/^│\s*/, "").trim();
	const tabIcons = new Set(Object.values(SIDEBAR_TAB_ICONS));
	return (
		content.length > 0 &&
		content
			.split(/\s+/)
			.every((glyph) => tabIcons.has(glyph as (typeof SIDEBAR_TAB_ICONS)[keyof typeof SIDEBAR_TAB_ICONS]))
	);
}

it.each([16, 44, 120])("clicks centered and wrapped tabs at %i fullscreen columns", (columns) => {
	let tab: SidebarTab = "tools";
	const snapshot = buildSidebarSnapshot({
		state: createInertAtelierState(),
		cwd: "/repo",
		branchEntryCount: 0,
		extensionStatuses: [],
	});
	let deliverInput: ((data: string) => void) | undefined;
	const renderer = new TuiAltScreen({
		columns,
		rows: 30,
		write: () => {},
		start: (onInput: (data: string) => void) => {
			deliverInput = onInput;
		},
		stop: () => {},
		hideCursor: () => {},
		showCursor: () => {},
	} as never);
	const component = createSidebarComponent({
		getSnapshot: () => snapshot,
		getHeight: () => 30,
		getTab: () => tab,
		setTab: (next) => {
			tab = next;
		},
		theme,
	});
	renderer.setLayoutRoot(new VStack([{ component, grow: 1 }]));
	try {
		renderer.start();
		renderer.renderNow();
		const toolsRow = renderer.getScreenLines().findIndex((line) => line.includes(SIDEBAR_TAB_ICONS.tools));
		expect(toolsRow).toBeGreaterThan(0);
		deliverInput?.(`\u001b[<0;2;${toolsRow + 1}M`);
		expect(tab).toBe("tools");
		for (const [targetTab, icon] of Object.entries(SIDEBAR_TAB_ICONS)) {
			for (const paddingColumnOffset of [-1, 2]) {
				renderer.renderNow();
				const lines = renderer.getScreenLines().map(stripTerminalSequences);
				const row = lines.findIndex((line) => isTabSelectorRow(line) && line.includes(icon));
				expect(row).toBeGreaterThan(0);
				const line = lines[row]!;
				const iconColumn = visibleWidth(line.slice(0, line.indexOf(icon)));
				const terminalColumn = iconColumn + paddingColumnOffset + 1;
				deliverInput?.(`\u001b[<0;${terminalColumn};${row + 1}M`);
				expect(tab).toBe(targetTab);
			}
		}
	} finally {
		renderer.stop();
	}
});

it.each([
	{ width: 28, expectedRows: ["󰋚    󰨸    󰄬    󰆧    󰅴", "󰒓"] },
	{ width: 44, expectedRows: ["󰋚    󰨸    󰄬    󰆧    󰅴    󰒓"] },
	{ width: 16, expectedRows: ["󰋚    󰨸    󰄬", "󰆧    󰅴    󰒓"] },
	{ width: 17, expectedRows: ["󰋚    󰨸    󰄬", "󰆧    󰅴    󰒓"] },
	{ width: 21, expectedRows: ["󰋚    󰨸    󰄬    󰆧", "󰅴    󰒓"] },
])("centers equal-width tab cells on every selector row at $width columns", ({ width, expectedRows }) => {
	const snapshot = buildSidebarSnapshot({
		state: createInertAtelierState(),
		cwd: "/repo",
		branchEntryCount: 0,
		extensionStatuses: [],
	});
	const component = createSidebarComponent({
		getSnapshot: () => snapshot,
		getHeight: () => 30,
		theme,
	});
	const selectorLines = component
		.render(width)
		.map(stripTerminalSequences)
		.filter(isTabSelectorRow)
		.map((line) => line.slice(2));
	expect(selectorLines.map((line) => line.trim())).toEqual(expectedRows);
	for (const line of selectorLines) {
		const iconLeadingPadding = 1;
		const iconTrailingPadding = 2;
		const leftPadding = visibleWidth(line) - visibleWidth(line.trimStart()) - iconLeadingPadding;
		const rightPadding = visibleWidth(line) - visibleWidth(line.trimEnd()) - iconTrailingPadding;
		expect(Math.abs(leftPadding - rightPadding)).toBeLessThanOrEqual(1);
		expect(visibleWidth(line)).toBe(width - 2);
		expect(line).not.toMatch(/[\[\]]/);
	}
});

it.each(Object.keys(SIDEBAR_TAB_ICONS) as SidebarTab[])(
	"distinguishes the active %s tab by color alone without changing spacing",
	(tab) => {
		const snapshot = buildSidebarSnapshot({
			state: createInertAtelierState(),
			cwd: "/repo",
			branchEntryCount: 0,
			extensionStatuses: [],
		});
		const component = createSidebarComponent({
			getSnapshot: () => snapshot,
			getHeight: () => 30,
			getTab: () => tab,
			theme: { ...theme, name: "dark" },
		});
		const rows = component.render(44);
		const selectorRow = rows.findIndex((row) => row.includes(SIDEBAR_TAB_ICONS.tools));
		const selectorLine = rows[selectorRow]!;
		expect(stripTerminalSequences(selectorLine).trim()).toBe("│        󰋚    󰨸    󰄬    󰆧    󰅴    󰒓");
		for (const [targetTab, icon] of Object.entries(SIDEBAR_TAB_ICONS)) {
			const color = targetTab === tab ? "177;140;255" : "128;128;128";
			expect(selectorLine).toContain(`\u001b[38;2;${color}m ${icon}  \u001b[39m`);
		}
		expect(rows.join("\n")).not.toContain("\u001b[4m");
		expect(rows.join("\n")).not.toContain("━");
		expect(visibleWidth(selectorLine)).toBe(44);
	},
);

it("renders icon-only selectors and a wrapped Plannotator checklist", () => {
	const plan = {
		phase: "executing" as const,
		planPath: "plans/sidebar.md",
		completed: 1,
		total: 2,
		items: [
			{ step: 1, text: "Use icons", completed: true },
			{ step: 2, text: "Navigate to the matching transcript output", completed: false },
		],
	};
	const snapshot = buildSidebarSnapshot({
		state: createInertAtelierState(),
		cwd: "/repo",
		branchEntryCount: 0,
		extensionStatuses: [],
		plannotator: plan,
	});
	const component = createSidebarComponent({
		getSnapshot: () => snapshot,
		getHeight: () => 30,
		getTab: () => "tasks",
		theme,
	});
	const rendered = component.render(28).join("\n");
	for (const icon of Object.values(SIDEBAR_TAB_ICONS)) {
		expect(rendered).toContain(icon);
	}
	expect(rendered).not.toMatch(/\[(tools|summary|tasks|sandbox|settings)\]/);
	expect(rendered).toContain("1/2 complete");
	expect(rendered).toContain("󰄬 1. Use icons");
	expect(rendered).toContain("󰄱 2. Navigate");
	for (const width of [0, 1, 26, 42]) {
		for (const row of renderTasksContent(plan, theme, width, false)) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	}
	expect(renderTasksContent(undefined, theme, 42).join("\n")).toContain("No active Plannotator plan");
	expect(renderTasksContent({ phase: "planning" }, theme, 42).join("\n")).toContain("awaiting approval");
});

it("clicks a scrolled log line to reveal its exact tool in the main transcript", () => {
	initTheme("dark", false);
	let deliverInput: ((data: string) => void) | undefined;
	const renderer = new TuiAltScreen({
		columns: 120,
		rows: 12,
		write: () => {},
		start: (onInput: (data: string) => void) => {
			deliverInput = onInput;
		},
		stop: () => {},
		hideCursor: () => {},
		showCursor: () => {},
	} as never);
	const transcriptContainer = new Container();
	transcriptContainer.addChild({
		render: () => Array.from({ length: 40 }, (_, index) => `Earlier ${index}`),
		invalidate() {},
	});
	const tool = new ToolExecutionComponent(
		"read",
		"read-target",
		{ path: "target.ts" },
		undefined,
		undefined,
		renderer,
		"/repo",
	);
	transcriptContainer.addChild(tool);
	transcriptContainer.addChild({
		render: () => Array.from({ length: 40 }, (_, index) => `Later ${index}`),
		invalidate() {},
	});
	const transcript = new ScrollView(transcriptContainer, {
		primary: true,
		follow: "end",
		scrollbar: "hidden",
	});
	renderer.setLayoutRoot(new VStack([{ component: transcript, grow: 1 }]));
	const snapshot = buildSidebarSnapshot({
		state: createInertAtelierState(),
		cwd: "/repo",
		branchEntryCount: 0,
		extensionStatuses: [],
		runActivity: {
			...EMPTY_RUN_ACTIVITY,
			recentTools: Array.from({ length: 18 }, (_, index) => ({
				id: index === 3 ? "read-target" : `tool-${index}`,
				name: "read",
				summary: index === 3 ? "target.ts" : `file-${index}.ts`,
				status: "done" as const,
				startedAt: index,
				durationMs: 10,
			})),
		},
	});
	const split = createSplitPaneController();
	const navigateToTool = vi.fn((id: string) => split.scrollToTool(id));
	const sidebar = createSidebarComponent({
		getSnapshot: () => snapshot,
		getHeight: () => 12,
		theme,
		navigateToTool,
	});
	split.attach(renderer, sidebar);
	split.show();
	try {
		renderer.start();
		renderer.renderNow();
		expect(transcript.isFollowingEnd).toBe(true);
		const logContentTerminalRow = 5;
		deliverInput?.(`\u001b[<65;80;${logContentTerminalRow}M`);
		renderer.renderNow();
		const row = renderer.getScreenLines().findIndex((line) => line.includes("target.ts"));
		expect(row).toBeGreaterThan(0);
		deliverInput?.(`\u001b[<0;80;${row + 1}M`);
		expect(navigateToTool).toHaveBeenCalledWith("read-target");
		expect(transcript.scrollTop).toBe(40);
		expect(transcript.isFollowingEnd).toBe(false);
	} finally {
		split.dispose();
		renderer.stop();
	}
});
