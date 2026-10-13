import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { visibleWidth, MouseRegion } from "@earendil-works/pi-tui";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thirdPartySettings } from "../src/third-party-settings.js";
import { createSidebarSettings } from "../src/settings.js";
import { registerSettingsSection, type SettingsSection } from "@paulsteele/pi-shared-ui";
import { buildSidebarSnapshot, createSidebarComponent, renderSandboxContent } from "../src/sidebar.js";
import { parseSandboxState } from "../src/sandbox-state.js";
import { createSandboxPublisher } from "../../pi-permission-system/src/sandbox/events.js";

const directories: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});
function tool(name: string, source: string): ToolInfo {
	return {
		name,
		sourceInfo: { source, origin: "package", scope: "user", path: "/installed/index.ts" },
	} as ToolInfo;
}
function loadedPackages() {
	return {
		getAllTools: () => [
			tool("web_search", "npm:pi-web-access@0.37.0"),
			tool("plannotator_submit_plan", "npm:@plannotator/pi-extension"),
			tool("ask_user_question", "npm:@juicesharp/rpiv-ask-user-question"),
		],
	};
}

it("exposes third-party sections only for loaded package owners", () => {
	expect(thirdPartySettings(loadedPackages()).map((section) => section.id)).toEqual([
		"web",
		"plannotator",
		"plannotator-phases",
		"questionnaire",
	]);
	expect(thirdPartySettings({ getAllTools: () => [tool("web_search", "npm:unrelated")] })).toEqual([]);
});

it("lists one plugin root for Sandbox, Code Quality, and Plannotator", () => {
	const subscribers = new Map<string, Set<(value: unknown) => void>>();
	const pi = {
		...loadedPackages(),
		events: {
			on(channel: string, subscriber: (value: unknown) => void) {
				const listeners = subscribers.get(channel) ?? new Set();
				listeners.add(subscriber);
				subscribers.set(channel, listeners);
				return () => listeners.delete(subscriber);
			},
			emit(channel: string, value: unknown) {
				for (const subscriber of subscribers.get(channel) ?? []) {
					subscriber(value);
				}
			},
		},
	};
	const sandboxPlugin = { id: "sandbox", title: "Sandbox", description: "Container settings" };
	const qualityPlugin = { id: "quality", title: "Code Quality", description: "Review settings" };
	const sections: SettingsSection[] = [
		{
			id: "sandbox",
			title: "General",
			plugin: sandboxPlugin,
			description: "Permissions",
			fields: [],
			effect: "",
			load: async () => ({ value: {}, apply: async () => {} }),
		},
		{
			id: "host-commands",
			title: "Host Commands",
			plugin: sandboxPlugin,
			description: "Native routing",
			fields: [],
			effect: "",
			load: async () => ({ value: {}, apply: async () => {} }),
		},
		{
			id: "quality",
			title: "Reviewer",
			plugin: qualityPlugin,
			description: "Review model",
			fields: [],
			effect: "",
			load: async () => ({ value: {}, apply: async () => {} }),
		},
		{
			id: "lsp",
			title: "Language Servers",
			plugin: qualityPlugin,
			description: "Routes",
			fields: [],
			effect: "",
			load: async () => ({ value: {}, apply: async () => {} }),
		},
	];
	for (const section of sections) {
		registerSettingsSection(pi, section);
	}
	const settings = createSidebarSettings(pi as never, {} as ExtensionContext);
	const roots = settings.sections();
	expect(roots.map((root) => root.id)).toEqual(["sandbox", "quality", "web", "plannotator", "questionnaire"]);
	expect(roots.find((root) => root.id === "sandbox")?.children?.map((child) => child.id)).toEqual([
		"sandbox",
		"host-commands",
	]);
	expect(roots.find((root) => root.id === "quality")?.children?.map((child) => child.id)).toEqual([
		"quality",
		"lsp",
	]);
	expect(roots.find((root) => root.id === "plannotator")?.children?.map((child) => child.id)).toEqual([
		"plannotator",
		"plannotator-phases",
	]);
	settings.dispose();
});

it("marks credential and header fields private without resolving their values", () => {
	const web = thirdPartySettings(loadedPackages()).find((section) => section.id === "web")!;
	expect(web.fields.find((field) => field.path === "braveApiKey")?.secret).toBe(true);
	expect(web.fields.find((field) => field.path === "searxngHeaders")?.secret).toBe(true);
	expect(web.fields.find((field) => field.path === "authFetch")?.secret).toBe(true);
});

it("web edits preserve unknown settings and credentials in the original configuration file", async () => {
	const directory = await mkdtemp(join(tmpdir(), "sidebar-settings-"));
	directories.push(directory);
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	const path = join(directory, "web-search.json");
	await writeFile(
		path,
		JSON.stringify({ workflow: "none", braveApiKey: "!secret-manager read brave", futureOption: true }),
	);
	const web = thirdPartySettings(loadedPackages()).find((section) => section.id === "web")!;
	const draft = await web.load({} as ExtensionContext);
	await draft.apply({ ...draft.value, workflow: "auto-summary" });
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
		workflow: "auto-summary",
		braveApiKey: "!secret-manager read brave",
		futureOption: true,
	});
});

it("opening settings during agent work does not read or write configuration", async () => {
	const ctx = { isIdle: () => false, ui: { notify: vi.fn() } } as unknown as ExtensionContext;
	const settings = createSidebarSettings({ events: { emit() {}, on: () => () => {} } } as never, ctx);
	await settings.open("web");
	expect(ctx.ui.notify).toHaveBeenCalledWith("Settings are available when the agent is idle.", "info");
	settings.dispose();
});

it("does not open Settings while an idle background extension owns a permission prompt", async () => {
	const listeners = new Map<string, (raw: unknown) => void>();
	const ctx = { isIdle: () => true, ui: { notify: vi.fn() } } as unknown as ExtensionContext;
	const settings = createSidebarSettings(
		{
			events: {
				emit() {},
				on: (name: string, listener: (raw: unknown) => void) => {
					listeners.set(name, listener);
					return () => listeners.delete(name);
				},
			},
		} as never,
		ctx,
	);
	listeners.get("permissions:ui_prompt")!({ requestId: "approval" });
	await settings.open("web");
	expect(ctx.ui.notify).toHaveBeenCalledWith(
		"Finish the permission decision before reopening Settings.",
		"info",
	);
	listeners.get("permissions:decision")!({ requestId: "approval" });
	settings.dispose();
	expect(listeners.size).toBe(0);
});

it("preserves the unavailable phase through multiline engine diagnostics and Sidebar rendering", () => {
	let published: unknown;
	const publisher = createSandboxPublisher({
		on: () => () => {},
		emit: (_channel, value) => {
			published = value;
		},
	});
	publisher.update({
		sessionId: "session",
		phase: "unavailable",
		definitionPath: "/private/devcontainer.json",
		mounts: [],
		ports: [],
		error: "Engine failed\n\u001b[31mSecond diagnostic line\u001b[0m\n" + "x".repeat(5000),
	});
	const state = parseSandboxState(published);
	expect(state?.phase).toBe("unavailable");
	expect(state?.error?.length).toBe(4096);
	expect(state?.error).toContain("Engine failed Second diagnostic line");
	const rendered = renderSandboxContent(
		state,
		{
			fg: (_color, text) => text,
			bold: (text) => text,
			italic: (text) => text,
		},
		100,
		false,
	).join("\n");
	expect(rendered).toContain("UNAVAILABLE");
	expect(rendered).toContain("Engine failed");
	publisher.dispose();
});

it("Settings stays reachable at narrow sidebar widths and lists clickable sections", () => {
	const snapshot = buildSidebarSnapshot({
		cwd: "/project",
		branchEntryCount: 0,
		extensionStatuses: [],
		state: {
			activity: "ready",
			dirty: false,
			workspacePulse: { status: "unavailable" },
			extensionStatuses: [],
			metrics: {} as never,
		},
	});
	const openSettings = vi.fn();
	const component = createSidebarComponent({
		getSnapshot: () => snapshot,
		getHeight: () => 30,
		theme: { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text },
		getTab: () => "settings",
		openSettings,
		getSettingsSections: () => [{ id: "quality", title: "Code Quality", description: "Reviewer and limits" }],
	});
	for (const width of [28, 44]) {
		const rows = component.render(width);
		expect(rows.join("\n")).toContain("󰒓");
		expect(rows.join("\n")).not.toContain("━");
		expect(rows.join("\n")).toContain("› Code Quality");
		for (const row of rows) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	}
	const layoutSymbol = Symbol.for("@earendil-works/pi-tui/layout-node");
	const regions: MouseRegion[] = [];
	interface InspectableComponent {
		[key: symbol]: (() => { entries?: Array<{ component: unknown }> } | undefined) | undefined;
		child?: unknown;
	}
	const collectMouseRegions = (componentNode: InspectableComponent) => {
		if (componentNode instanceof MouseRegion) {
			regions.push(componentNode);
		}
		const entries = componentNode[layoutSymbol]?.()?.entries ?? [];
		for (const entry of entries) {
			collectMouseRegions(entry.component as InspectableComponent);
		}
		if (componentNode.child) {
			collectMouseRegions(componentNode.child as InspectableComponent);
		}
	};
	collectMouseRegions(component as unknown as InspectableComponent);
	const section = regions.find((region) => region.render(30).join("\n").includes("› Code Quality"));
	expect(section).toBeDefined();
	section!.handleMouse({ type: "press", button: "left", x: 1, y: 0 } as never);
	expect(openSettings).toHaveBeenCalledWith("quality");
});
