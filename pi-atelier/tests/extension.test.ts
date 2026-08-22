import { describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import atelierExtension, { SIDEBAR_PANEL_EVENT_CHANNEL } from "../extensions/index.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const execResult = (stdout: string, code = 0) => ({
	stdout,
	stderr: "",
	code,
	killed: false,
});

function harness(
	mode: "tui" | "print" = "tui",
	_legacyPlatform: NodeJS.Platform = "linux",
	interactiveMenus = false,
	_extensionDependencies: Record<string, never> = {},
	options: { throwOnEventUnsubscribe?: readonly string[]; throwOnEventSubscribe?: readonly string[] } = {},
) {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const commands = new Map<string, any>();
	const eventBusHandlers = new Map<string, Set<(data: unknown) => void>>();
	const shortcuts: string[] = [];
	const setFooter = vi.fn();
	const setWidget = vi.fn();
	let terminalInput: ((data: string) => unknown) | undefined;
	const terminalWrite = vi.fn();
	const baseRender = vi.fn((width: number) => [`main:${width}`]);
	const overlays: Array<{
		component: any;
		done: ReturnType<typeof vi.fn>;
		closed: boolean;
		handle: { hide: ReturnType<typeof vi.fn> };
		options: any;
		requestRender: ReturnType<typeof vi.fn>;
		tui: any;
	}> = [];
	const pi = {
		on: vi.fn((name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler)),
		events: {
			on: vi.fn((channel: string, handler: (data: unknown) => void) => {
				if (options.throwOnEventSubscribe?.includes(channel)) throw new Error(`subscribe failed: ${channel}`);
				const channelHandlers = eventBusHandlers.get(channel) ?? new Set();
				channelHandlers.add(handler);
				eventBusHandlers.set(channel, channelHandlers);
				return () => {
					if (options.throwOnEventUnsubscribe?.includes(channel))
						throw new Error(`unsubscribe failed: ${channel}`);
					return channelHandlers.delete(handler);
				};
			}),
			emit: vi.fn((channel: string, data: unknown) => {
				for (const handler of eventBusHandlers.get(channel) ?? []) handler(data);
			}),
		},
		registerCommand: vi.fn((name: string, options: any) => commands.set(name, options)),
		registerShortcut: vi.fn((key: string) => shortcuts.push(key)),
		exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
		getThinkingLevel: vi.fn().mockReturnValue("medium"),
		getActiveTools: vi.fn().mockReturnValue(["read"]),
		getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
		setSessionName: vi.fn(),
	};
	const custom = vi.fn((factory: (...args: any[]) => any, options: any): Promise<any> => {
		const requestRender = vi.fn();
		const tui = {
			render: baseRender,
			terminal: { columns: 120, rows: 36, width: 120, write: terminalWrite },
			requestRender,
		};
		let resolve!: (value: any) => void;
		const pending = new Promise<any>((done) => {
			resolve = done;
		});
		const done = vi.fn((value?: any) => {
			// Pi pops the overlay off the stack inside `done`, so a closed overlay never renders again.
			const entry = overlays.find((candidate) => candidate.done === done);
			if (entry) entry.closed = true;
			resolve(value);
		});
		const handle = { hide: vi.fn() };
		const component = factory(
			tui,
			{
				name: "dark",
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				italic: (text: string) => text,
			},
			{},
			done,
		);
		requestRender.mockClear();
		overlays.push({ component, done, closed: false, handle, options, requestRender, tui });
		options?.onHandle?.(handle);
		const overlayOptions =
			typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
		if (!overlayOptions?.nonCapturing && !interactiveMenus) done();
		return pending;
	});
	const ctx = {
		mode,
		cwd: "/tmp/project",
		isProjectTrusted: vi.fn().mockReturnValue(false),
		isIdle: vi.fn().mockReturnValue(true),
		getContextUsage: vi.fn().mockReturnValue({ tokens: 10, contextWindow: 100, percent: 10 }),
		model: undefined,
		modelRegistry: { isUsingOAuth: vi.fn().mockReturnValue(false) },
		compact: vi.fn(),
		sessionManager: {
			getEntries: vi.fn().mockReturnValue([]),
			getBranch: vi.fn().mockReturnValue([]),
			getSessionName: vi.fn().mockReturnValue("Test session"),
			getSessionFile: vi.fn().mockReturnValue("/tmp/session.jsonl"),
		},
		ui: {
			setFooter,
			setWidget,
			notify: vi.fn(),
			theme: {},
			select: vi.fn(),
			custom,
			onTerminalInput: vi.fn((handler) => {
				terminalInput = handler;
				return () => {
					if (terminalInput === handler) terminalInput = undefined;
				};
			}),
		},
	};
	atelierExtension(pi as never);
	return {
		handlers,
		commands,
		shortcuts,
		setFooter,
		setWidget,
		ctx,
		pi,
		overlays,
		custom,
		terminalWrite,
		baseRender,
		getEventBusHandlerCount(channel: string) {
			return eventBusHandlers.get(channel)?.size ?? 0;
		},
		get terminalInput() {
			return terminalInput;
		},
	};
}

function replacementContext(
	base: ReturnType<typeof harness>["ctx"],
	sessionName: string,
): ReturnType<typeof harness>["ctx"] {
	return {
		...base,
		sessionManager: {
			...base.sessionManager,
			getSessionName: vi.fn().mockReturnValue(sessionName),
			getSessionFile: vi.fn().mockReturnValue(`/tmp/${sessionName.toLowerCase().replace(/\s+/g, "-")}.jsonl`),
		},
	};
}

async function start(h: ReturnType<typeof harness>, ctx = h.ctx) {
	await h.handlers.get("session_start")?.({ reason: "startup" }, ctx);
}

async function command(h: ReturnType<typeof harness>, args: string, ctx = h.ctx) {
	await h.commands.get("atelier").handler(args, ctx);
}

function renderOverlayText(h: ReturnType<typeof harness>, index = 0, width = 44): string {
	const overlay = h.overlays[index];
	if (!overlay) return "";
	if (overlay.closed) throw new Error(`overlay ${index} is closed; Pi would not render it`);
	return overlay.component.render(width).join("\n");
}

const FOOTER_THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};

/** Builds a footer from a captured `setFooter` factory and renders it once, as Pi would. */
function renderFooter(
	factory: any,
	requestRender: () => void,
	getExtensionStatuses: () => Map<string, string> = () => new Map(),
): any {
	const component = factory({ requestRender }, FOOTER_THEME, {
		getGitBranch: () => undefined,
		getExtensionStatuses,
		onBranchChange: () => () => undefined,
	});
	component.render(120);
	return component;
}

function queueWorkspacePulseInspection(
	h: ReturnType<typeof harness>,
	firstResult: Promise<ReturnType<typeof execResult>> = Promise.resolve(execResult("true\n/tmp/project\n")),
): void {
	const results = [
		firstResult,
		Promise.resolve(
			execResult(
				"# branch.oid abcdef\0# branch.head stale-branch\0" +
					"1 .M N... 100644 100644 100644 abcdef abcdef tracked.txt\0? untracked.txt\0",
			),
		),
		Promise.resolve(execResult("treeish\n")),
		Promise.resolve(execResult("5\t2\ttracked.txt\0")),
	];
	h.pi.exec.mockImplementation(() => results.shift() ?? Promise.resolve(execResult("", 1)));
}

async function waitForWorkspacePulseInspection(h: ReturnType<typeof harness>): Promise<void> {
	await vi.waitFor(() => expect(h.pi.exec).toHaveBeenCalledTimes(4));
	await Promise.resolve();
}

describe("extension registration", () => {
	it("discovers and renders a structured contributed panel through pi.events", async () => {
		const h = harness();
		await start(h);
		h.pi.events.emit(SIDEBAR_PANEL_EVENT_CHANNEL, {
			version: 1,
			type: "register",
			source: "vendor",
			revision: 1,
			panel: { id: "vendor:queue", title: "Queue", rows: ["queued 2"] },
		});
		await command(h, "on");
		const rendered = h.overlays.at(-1)?.component.render(44).join("\\n") ?? "";
		expect(rendered).toContain("QUEUE");
		expect(rendered).toContain("queued 2");
	});

	it("renders Plannotator planning as a native panel and clears only its duplicate widget", async () => {
		const h = harness();
		h.ctx.sessionManager.getBranch.mockReturnValue([
			{ type: "custom", customType: "plannotator", data: { phase: "planning", lastSubmittedPath: null } },
		]);
		await start(h);
		const rendered = renderOverlayText(h);
		expect(rendered).toContain("PLANNOTATOR");
		expect(rendered).toContain("Planning");
		await vi.waitFor(() => expect(h.setWidget).toHaveBeenCalledWith("plannotator-progress", undefined));
	});

	it("registers the command, no shortcuts, and one footer in TUI mode", async () => {
		const h = harness();
		expect(h.commands.has("atelier")).toBe(true);
		await start(h);
		expect(h.setFooter).toHaveBeenCalledTimes(1);
		expect(h.shortcuts).toEqual([]);
	});

	it("does not install terminal UI outside TUI mode", async () => {
		const h = harness("print");
		await start(h);
		expect(h.setFooter).not.toHaveBeenCalled();
	});

	it("retires active TUI state when a non-TUI session starts", async () => {
		const h = harness("tui", "darwin");
		await start(h);
		expect(h.getEventBusHandlerCount(SIDEBAR_PANEL_EVENT_CHANNEL)).toBe(1);

		const printContext = { ...replacementContext(h.ctx, "Print session"), mode: "print" as const };
		await start(h, printContext);

		expect(h.getEventBusHandlerCount(SIDEBAR_PANEL_EVENT_CHANNEL)).toBe(0);
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
		await command(h, "on", h.ctx);
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Pi Atelier is not active in this session", "warning");
	});

	it("clears the retired footer when a TUI session with a distinct UI replaces it", async () => {
		const h = harness();
		await start(h);
		const replacementSetFooter = vi.fn();
		const replacementNotify = vi.fn();
		const replacementCtx = {
			...replacementContext(h.ctx, "Distinct UI replacement"),
			ui: {
				...h.ctx.ui,
				setFooter: replacementSetFooter,
				notify: replacementNotify,
			},
		};

		await start(h, replacementCtx);

		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
		expect(replacementSetFooter).toHaveBeenCalledOnce();
		expect(replacementSetFooter).toHaveBeenLastCalledWith(expect.any(Function));
		expect(replacementSetFooter).not.toHaveBeenCalledWith(undefined);
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(renderOverlayText(h, 1)).toContain("Distinct UI replacement");
	});

	it("keeps cleanup exception-safe when independent disposers throw", async () => {
		const h = harness(
			"tui",
			"darwin",
			false,
			{},
			{
				throwOnEventUnsubscribe: [SIDEBAR_PANEL_EVENT_CHANNEL],
			},
		);
		await start(h);
		h.setFooter.mockImplementation((value) => {
			if (value === undefined) throw new Error("footer cleanup failed");
		});

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		await command(h, "on");
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Pi Atelier is not active in this session", "warning");
	});

	it("keeps active Sidebar snapshot failures visible", async () => {
		const h = harness();
		await start(h);
		h.ctx.sessionManager.getBranch.mockImplementation(() => {
			throw new Error("snapshot read failed");
		});

		const sidebar = renderOverlayText(h);
		expect(sidebar).toContain("Sidebar unavailable");
		expect(sidebar).toContain("snapshot read failed");
	});

	it("starts enabled and toggles the persistent sidebar on -> off -> on", async () => {
		const h = harness();
		await start(h);
		expect(h.overlays).toHaveLength(1);
		expect(h.overlays[0]?.options).toMatchObject({
			overlay: true,
			overlayOptions: expect.any(Function),
			onHandle: expect.any(Function),
		});
		expect(h.overlays[0]?.options.overlayOptions()).toMatchObject({ nonCapturing: true });
		await command(h, "");
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		await command(h, "");
		expect(h.custom).toHaveBeenCalledTimes(2);
	});

	it("supports idempotent sidebar on and off commands", async () => {
		const h = harness();
		await start(h);
		await command(h, "on");
		await command(h, "on");
		expect(h.custom).toHaveBeenCalledOnce();
		await command(h, "off");
		await command(h, "off");
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
	});

	it("keeps Pi rendering untouched beneath the visible sidebar", async () => {
		const h = harness();
		await start(h);
		await command(h, "on");

		expect(h.overlays[0]?.options.overlayOptions()).toMatchObject({ width: 44 });
		expect(h.overlays[0]?.tui.render(120)).toEqual(["main:120"]);

		await command(h, "off");
		expect(h.overlays[0]?.tui.render(120)).toEqual(["main:120"]);
	});

	it("closes an enabled sidebar during shutdown", async () => {
		const h = harness();
		await start(h);
		await command(h, "on");

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
		expect(h.terminalWrite).not.toHaveBeenCalled();
		expect(h.terminalInput).toBeUndefined();
	});

	it("does not retain published state when initialization fails", async () => {
		const h = harness("tui", "darwin");
		await start(h);

		const failingCtx = replacementContext(h.ctx, "Failing session");
		const failedFooterRender = vi.fn();
		h.setFooter.mockImplementation((footer) => {
			if (typeof footer !== "function") return;
			renderFooter(footer, failedFooterRender);
			throw new Error("footer install failed");
		});

		await start(h, failingCtx);

		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(
			"Pi Atelier could not start: footer install failed",
			"error",
		);
		// A failing initializer never opens a sidebar, so only the first session's overlay exists.
		expect(h.overlays).toHaveLength(1);

		failedFooterRender.mockClear();
		await h.handlers.get("session_tree")?.({ type: "session_tree" }, failingCtx);
		expect(failedFooterRender).not.toHaveBeenCalled();

		const overlayCount = h.overlays.length;
		await command(h, "on", failingCtx);
		expect(h.overlays).toHaveLength(overlayCount);
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Pi Atelier is not active in this session", "warning");
	});

	it("stops a scheduled workspace pulse refresh after shutdown", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			await start(h);
			const timersBeforeSchedule = vi.getTimerCount();
			await h.handlers.get("tool_execution_end")?.(
				{
					type: "tool_execution_end",
					toolCallId: "pulse-tool",
					toolName: "write",
					result: { output: "" },
				},
				h.ctx,
			);
			expect(vi.getTimerCount()).toBeGreaterThan(timersBeforeSchedule);
			const execCallsBeforeShutdown = h.pi.exec.mock.calls.length;

			await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
			expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBeforeSchedule);
			await vi.advanceTimersByTimeAsync(1_000);

			expect(h.pi.exec.mock.calls.length).toBe(execCallsBeforeShutdown);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not publish an in-flight workspace pulse refresh after shutdown", async () => {
		const active = harness();
		queueWorkspacePulseInspection(active);
		await start(active);
		await waitForWorkspacePulseInspection(active);
		// Positive control: a published pulse does reach the sidebar.
		expect(renderOverlayText(active)).toContain("stale-branch");
		expect(renderOverlayText(active)).toContain("1 tracked");
		await active.handlers.get("session_shutdown")?.({ reason: "quit" }, active.ctx);
		expect(active.overlays[0]?.done).toHaveBeenCalledOnce();

		const discovery = deferred<ReturnType<typeof execResult>>();
		const h = harness();
		queueWorkspacePulseInspection(h, discovery.promise);
		await start(h);
		await vi.waitFor(() => expect(h.pi.exec).toHaveBeenCalledOnce());

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
		h.overlays[0]?.requestRender.mockClear();
		discovery.resolve(execResult("true\n/tmp/project\n"));
		await waitForWorkspacePulseInspection(h);

		expect(h.overlays[0]?.requestRender).not.toHaveBeenCalled();
	});

	it("disposes a mounted footer when setFooter removal throws", async () => {
		const h = harness();
		let mountedFooter: any;
		const unsubscribe = vi.fn();
		let branchChange: (() => void) | undefined;
		h.setFooter.mockImplementation((value: unknown) => {
			if (value === undefined) throw new Error("footer removal failed");
			if (typeof value === "function") {
				mountedFooter = value({ requestRender: vi.fn() }, FOOTER_THEME, {
					getGitBranch: () => undefined,
					getExtensionStatuses: () => new Map(),
					onBranchChange: (callback: () => void) => {
						branchChange = callback;
						return unsubscribe;
					},
				});
			}
		});
		await start(h);
		mountedFooter.render(120);

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

		expect(mountedFooter).toBeDefined();
		expect(unsubscribe).toHaveBeenCalledOnce();
		branchChange?.();
		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("detaches branch callbacks from a retired footer after removal fails", async () => {
		const h = harness();
		await start(h);
		let branchChange: (() => void) | undefined;
		const requestRender = vi.fn();
		const factory = h.setFooter.mock.calls[0]?.[0];
		expect(factory).toEqual(expect.any(Function));
		const footer = factory({ requestRender }, FOOTER_THEME, {
			getGitBranch: () => undefined,
			getExtensionStatuses: () => new Map(),
			onBranchChange: (callback: () => void) => {
				branchChange = callback;
				return () => undefined;
			},
		});
		footer.render(120);
		h.setFooter.mockImplementation((value: unknown) => {
			if (value === undefined) throw new Error("footer removal failed");
		});

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
		branchChange?.();
		expect(branchChange).toEqual(expect.any(Function));
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("stops reporting retired data from a footer that outlives its own removal", async () => {
		const h = harness();
		await start(h);
		const footer = renderFooter(
			h.setFooter.mock.calls[0]?.[0],
			vi.fn(),
			() => new Map([["one", "atelier index failed"]]),
		);
		expect(footer.render(120).join("\n")).toContain("atelier index failed");
		// Pi disposes the mounted footer inside `setFooter`; if that throws, the old footer stays live.
		h.setFooter.mockImplementation((value: unknown) => {
			if (value === undefined) throw new Error("footer removal failed");
		});
		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

		expect(() => footer.render(120)).not.toThrow();
		expect(footer.render(120).join("\n")).not.toContain("atelier index failed");
	});

	it("closes the old sidebar and starts the replacement visible on session reload", async () => {
		const h = harness();
		await start(h);

		await start(h);

		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		expect(h.custom).toHaveBeenCalledTimes(2);
		expect(h.overlays[1]?.done).not.toHaveBeenCalled();
	});

	it.each(["off", "on", "toggle"])("ignores stale session command: %s", async (args) => {
		const h = harness();
		const staleContext = h.ctx;
		await start(h, staleContext);
		const currentContext = replacementContext(h.ctx, "Replacement session");
		await start(h, currentContext);
		h.setFooter.mockClear();

		await command(h, args, staleContext);

		expect(h.overlays[1]?.done).not.toHaveBeenCalled();
		expect(renderOverlayText(h, 1)).toContain("Replacement session");
		expect(h.setFooter).not.toHaveBeenCalled();
		expect(staleContext.ui.notify).toHaveBeenLastCalledWith(
			"Pi Atelier is not active in this session",
			"warning",
		);
	});

	it("reopens by default on reload after an explicit session-scoped close", async () => {
		const h = harness();
		await start(h);
		await command(h, "off");
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();

		await start(h);

		expect(h.custom).toHaveBeenCalledTimes(2);
		expect(h.overlays[1]?.done).not.toHaveBeenCalled();
	});

	it("passes NO_COLOR through to sidebar rendering", async () => {
		const h = harness();
		vi.stubEnv("NO_COLOR", "1");
		try {
			await start(h);
			await command(h, "on");
			expect(h.overlays[0]?.component.render(44).join("\n")).not.toContain("\u001b[38;2;");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("warns instead of opening the sidebar outside TUI mode", async () => {
		const h = harness("print");
		await command(h, "");
		expect(h.custom).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("TUI mode"), "warning");
	});

	it("invalidates the sidebar once per actual footer status change", async () => {
		const h = harness();
		await start(h);
		await command(h, "on");
		h.overlays[0]?.requestRender.mockClear();
		let statuses = new Map([["one", "extension one"]]);
		const footer = h.setFooter.mock.calls[0]?.[0](
			{ requestRender: vi.fn() },
			{
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				italic: (text: string) => text,
			},
			{
				getGitBranch: () => undefined,
				getExtensionStatuses: () => statuses,
				onBranchChange: () => () => undefined,
			},
		);
		footer.render(120);
		footer.render(120);
		expect(h.overlays[0]?.requestRender).toHaveBeenCalledTimes(2);
		statuses = new Map([["one", "extension two"]]);
		footer.render(120);
		expect(h.overlays[0]?.requestRender).toHaveBeenCalledTimes(4);
	});

	it("forwards run and turn events into sidebar activity without putting tool history in the footer", async () => {
		const h = harness();
		await start(h);
		await command(h, "on");

		expect(h.handlers.has("turn_start")).toBe(true);
		expect(h.handlers.has("tool_execution_start")).toBe(true);
		expect(h.handlers.has("tool_execution_end")).toBe(true);

		await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 2, timestamp: 1_000 }, h.ctx);
		await h.handlers.get("tool_execution_start")?.(
			{
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "bash",
				args: { command: "npm test -- tests/extension.test.ts" },
			},
			h.ctx,
		);

		const sidebarText = h.overlays[0]?.component.render(44).join("\n") ?? "";
		expect(sidebarText).toContain("ACTIVITY");
		expect(sidebarText).toContain("Turn 3");
		expect(sidebarText).toContain("running");
		expect(sidebarText).toContain("bash");
		expect(sidebarText).toContain("npm test");
		expect(sidebarText).toContain("Working");
		expect(h.overlays[0]?.requestRender.mock.calls.length).toBeGreaterThan(0);

		const footer = h.setFooter.mock.calls[0]?.[0](
			{ requestRender: vi.fn() },
			{
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				italic: (text: string) => text,
			},
			{
				getGitBranch: () => undefined,
				getExtensionStatuses: () => new Map(),
				onBranchChange: () => () => undefined,
			},
		);
		await command(h, "off");
		const footerText = footer.render(160).join("\n");
		expect(footerText).toContain("●");
		expect(footerText).not.toContain("bash");
		expect(footerText).not.toContain("npm test");
	});

	it("measures TTFT from provider dispatch and final TPS from streamed generation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		try {
			const h = harness();
			await start(h);
			await command(h, "on");
			await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);

			vi.setSystemTime(1_100);
			await h.handlers.get("before_provider_request")?.(
				{ type: "before_provider_request", payload: {} },
				h.ctx,
			);
			vi.setSystemTime(1_920);
			await h.handlers.get("message_update")?.(
				{
					type: "message_update",
					message: { role: "assistant", content: [{ type: "thinking", thinking: "token" }] },
					assistantMessageEvent: { type: "thinking_delta", delta: "token" },
				},
				h.ctx,
			);

			const streamingText = h.overlays[0]?.component.render(44).join("\n") ?? "";
			expect(streamingText).toContain("TTFT 820ms · TPS ~");

			vi.setSystemTime(2_920);
			await h.handlers.get("message_update")?.(
				{
					type: "message_update",
					message: { role: "assistant", content: [{ type: "text", text: "x".repeat(80) }] },
					assistantMessageEvent: { type: "text_delta", delta: "more output" },
				},
				h.ctx,
			);
			const estimatedText = h.overlays[0]?.component.render(44).join("\n") ?? "";
			expect(estimatedText).toContain("TTFT 820ms · TPS ~20.0");

			vi.setSystemTime(4_420);
			await h.handlers.get("message_end")?.(
				{
					type: "message_end",
					message: { role: "assistant", usage: { output: 120 } },
				},
				h.ctx,
			);

			const completedText = h.overlays[0]?.component.render(44).join("\n") ?? "";
			expect(completedText).toContain("TTFT 820ms · TPS 48.0");
		} finally {
			vi.useRealTimers();
		}
	});

	it("coalesces a Turn-start Workspace Pulse refresh for 250ms", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			await start(h);
			const inspectionsAfterStart = h.pi.exec.mock.calls.length;

			await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 }, h.ctx);
			await vi.advanceTimersByTimeAsync(249);
			expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart);
			await vi.advanceTimersByTimeAsync(1);
			expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart + 1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("flushes a fresh Workspace Pulse at Turn end without leaving a scheduled duplicate", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			await start(h);
			const inspectionsAfterStart = h.pi.exec.mock.calls.length;

			await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 }, h.ctx);
			await h.handlers.get("turn_end")?.({ type: "turn_end" }, h.ctx);
			expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart + 1);

			await vi.advanceTimersByTimeAsync(1_000);
			expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart + 1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("coalesces rapid tool completions into one Workspace Pulse refresh", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			await start(h);
			const inspectionsAfterStart = h.pi.exec.mock.calls.length;

			for (const toolCallId of ["one", "two", "three"]) {
				await h.handlers.get("tool_execution_end")?.(
					{
						type: "tool_execution_end",
						toolCallId,
						toolName: "write",
						result: { content: [] },
						isError: false,
					},
					h.ctx,
				);
			}

			await vi.advanceTimersByTimeAsync(249);
			expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart);
			await vi.advanceTimersByTimeAsync(1);
			expect(h.pi.exec).toHaveBeenCalledTimes(inspectionsAfterStart + 1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("updates recent tool results and settles the sidebar without continuing animation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		try {
			const h = harness();
			await start(h);
			await command(h, "on");

			await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
			await h.handlers.get("tool_execution_start")?.(
				{
					type: "tool_execution_start",
					toolCallId: "read-1",
					toolName: "read",
					args: { path: "/tmp/project/src/run-activity.ts" },
				},
				h.ctx,
			);
			vi.setSystemTime(2_500);
			await h.handlers.get("tool_execution_end")?.(
				{
					type: "tool_execution_end",
					toolCallId: "read-1",
					toolName: "read",
					result: { content: [] },
					isError: false,
				},
				h.ctx,
			);

			const withResult = h.overlays[0]?.component.render(44).join("\n") ?? "";
			expect(withResult).toContain("read");
			expect(withResult).toContain("src/run-activity.ts");
			expect(withResult).toContain("done 1s");
			expect(withResult).toContain("tools 1 done · 0 failed");

			const rendersBeforeTick = h.overlays[0]?.requestRender.mock.calls.length ?? 0;
			vi.advanceTimersByTime(1_000);
			expect(h.overlays[0]?.requestRender.mock.calls.length).toBeGreaterThan(rendersBeforeTick);

			vi.setSystemTime(4_000);
			await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, h.ctx);
			const settledRenderCount = h.overlays[0]?.requestRender.mock.calls.length ?? 0;
			const settledText = h.overlays[0]?.component.render(44).join("\n") ?? "";
			expect(settledText).toContain("Last run · 3s");
			expect(settledText).not.toContain("settled 3s");
			expect(settledText).toContain("Ready");

			vi.advanceTimersByTime(3_000);
			expect(h.overlays[0]?.requestRender.mock.calls.length).toBe(settledRenderCount);
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears run activity across session reload and shutdown", async () => {
		const h = harness();
		await start(h);
		await command(h, "on");
		await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 5, timestamp: 1_000 }, h.ctx);
		await h.handlers.get("tool_execution_start")?.(
			{
				type: "tool_execution_start",
				toolCallId: "old-tool",
				toolName: "read",
				args: { path: "/tmp/project/old.ts" },
			},
			h.ctx,
		);
		expect(h.overlays[0]?.component.render(44).join("\n")).toContain("old.ts");

		await start(h);
		expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
		await command(h, "on");
		const replacementText = h.overlays[1]?.component.render(44).join("\n") ?? "";
		expect(replacementText).toContain("ACTIVITY");
		expect(replacementText).toContain("TTFT ~ · TPS ~");
		expect(replacementText).not.toContain("old.ts");

		const replacementRenderCount = h.overlays[1]?.requestRender.mock.calls.length ?? 0;
		await h.handlers.get("tool_execution_end")?.(
			{
				type: "tool_execution_end",
				toolCallId: "old-tool",
				toolName: "read",
				result: { content: [] },
				isError: false,
			},
			h.ctx,
		);
		expect(h.overlays[1]?.requestRender.mock.calls.length).toBe(replacementRenderCount);
		expect(h.overlays[1]?.component.render(44).join("\n")).not.toContain("old.ts");

		await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
		expect(h.overlays[1]?.done).toHaveBeenCalledOnce();
		const shutdownRenderCount = h.overlays[1]?.requestRender.mock.calls.length ?? 0;
		await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
		expect(h.overlays[1]?.requestRender.mock.calls.length).toBe(shutdownRenderCount);
	});

	it("accepts fresh Pi event contexts for the active session", async () => {
		const h = harness();
		await start(h);
		await command(h, "on");
		const eventCtx = { ...h.ctx };

		await h.handlers.get("agent_start")?.({ type: "agent_start" }, eventCtx);
		await h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0, timestamp: 1_000 }, eventCtx);

		const text = h.overlays[0]?.component.render(44).join("\n") ?? "";
		expect(text).toContain("Working");
		expect(text).toContain("ACTIVITY");
		expect(text).toContain("Turn 1");
	});

	it("ignores stale activity events after a replacement session becomes active", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		try {
			const h = harness();
			const oldCtx = h.ctx;
			const currentCtx = replacementContext(h.ctx, "Replacement session");
			await start(h, oldCtx);
			await command(h, "on", oldCtx);

			await start(h, currentCtx);
			expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
			await command(h, "on", currentCtx);

			await h.handlers.get("agent_start")?.({ type: "agent_start" }, currentCtx);
			await h.handlers.get("turn_start")?.(
				{ type: "turn_start", turnIndex: 6, timestamp: 1_000 },
				currentCtx,
			);
			await h.handlers.get("tool_execution_start")?.(
				{
					type: "tool_execution_start",
					toolCallId: "current-tool",
					toolName: "bash",
					args: { command: "npm run current" },
				},
				currentCtx,
			);

			const activeRenderCount = h.overlays[1]?.requestRender.mock.calls.length ?? 0;
			const activeText = h.overlays[1]?.component.render(44).join("\n") ?? "";
			expect(activeText).toContain("Replacement session");
			expect(activeText).toContain("ACTIVITY");
			expect(activeText).toContain("Turn 7");
			expect(activeText).toContain("running");
			expect(activeText).toContain("bash");
			expect(activeText).toContain("npm run current");
			expect(activeText).toContain("Working");

			await h.handlers.get("agent_start")?.({ type: "agent_start" }, oldCtx);
			await h.handlers.get("tool_execution_start")?.(
				{
					type: "tool_execution_start",
					toolCallId: "stale-tool",
					toolName: "read",
					args: { path: "/tmp/project/stale.ts" },
				},
				oldCtx,
			);
			await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, oldCtx);

			expect(h.overlays[1]?.requestRender.mock.calls.length).toBe(activeRenderCount);
			expect(h.overlays[1]?.component.render(44).join("\n")).toBe(activeText);
			expect(h.overlays[1]?.component.render(44).join("\n")).not.toContain("stale.ts");

			await h.handlers.get("tool_execution_end")?.(
				{
					type: "tool_execution_end",
					toolCallId: "current-tool",
					toolName: "bash",
					result: { stdout: "" },
					isError: false,
				},
				currentCtx,
			);
			await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, currentCtx);

			expect(h.overlays[1]?.requestRender.mock.calls.length).toBeGreaterThan(activeRenderCount);
			const settledText = h.overlays[1]?.component.render(44).join("\n") ?? "";
			expect(settledText).toContain("Last run · <1s");
			expect(settledText).not.toContain("Turn 7");
			expect(settledText).not.toContain("settled");
			expect(settledText).toContain("done");
			expect(settledText).toContain("Ready");
			expect(settledText).not.toContain("stale.ts");
		} finally {
			vi.useRealTimers();
		}
	});
});
