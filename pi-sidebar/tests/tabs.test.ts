import { expect, it } from "vitest";
import { TuiAltScreen, VStack, visibleWidth } from "@earendil-works/pi-tui";
import {
	buildSidebarSnapshot,
	createSidebarComponent,
	renderSandboxContent,
	renderSummaryContent,
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
		getHeight: () => 30,
		getTab: () => tab,
		setTab: (next) => {
			tab = next;
		},
		theme,
	});
	const tools = component.render(44).join("\n");
	expect(tools.indexOf("sandbox · ready")).toBeLessThan(tools.indexOf("[tools]"));
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

it("routes tab clicks through the actual fullscreen layout", () => {
	let tab: SidebarTab = "tools";
	const snapshot = buildSidebarSnapshot({
		state: createInertAtelierState(),
		cwd: "/repo",
		branchEntryCount: 0,
		extensionStatuses: [],
	});
	let deliverInput: ((data: string) => void) | undefined;
	const renderer = new TuiAltScreen({
		columns: 120,
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
	renderer.start();
	renderer.renderNow();
	const lines = renderer.render(120);
	const row = lines.findIndex((line) => line.includes("[tools]"));
	expect(row).toBeGreaterThan(0);
	const summaryTabColumn = 12;
	const tabSelectorTerminalRow = row + 1;
	const summaryTabClickInput = `\u001b[<0;${summaryTabColumn};${tabSelectorTerminalRow}M`;
	deliverInput?.(summaryTabClickInput);
	expect(tab).toBe("summary");
	renderer.stop();
});
