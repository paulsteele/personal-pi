import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import extension from "./index.js";
import { uiHarness } from "./ui.test.helpers.js";
import type { Report } from "./types.js";
import { providerUsage } from "./usage.js";
import { saveReport } from "./report.js";
const state = vi.hoisted(() => ({
	report: undefined as unknown,
	browser: undefined as unknown,
	failViewer: false,
	failSave: false,
	captureFailures: 0,
	viewerWait: undefined as Promise<void> | undefined,
	emitProgress: false,
	progressQueued: false,
	onProgressQueued: undefined as (() => void) | undefined,
	progressMessage: "Viewer preparing",
	progressCallback: undefined as ((message: string) => void) | undefined,
}));
vi.mock("./git.js", async (original) => ({
	...(await original<object>()),
	resolveRepo: async () => ({ root: "/fixture", commonDir: "/fixture/.git", id: "a".repeat(64) }),
}));
vi.mock("./storage.js", async (original) => ({
	...(await original<object>()),
	storageRoot: async () => "/private-runtime",
}));
vi.mock("./profile.js", async (original) => ({
	...(await original<object>()),
	loadProfile: async () => ({ profile: { draft: { exclusions: [] } }, revision: "fixture" }),
}));
vi.mock("./config.js", async (original) => ({
	...(await original<object>()),
	loadConfig: async () => ({ provider: "fake", model: "fixture", historyLimit: 20 }),
}));
vi.mock("./snapshot.js", () => ({
	capture: async () => {
		if (state.captureFailures-- > 0) throw new Error("Fixture source temporarily unavailable");
		return { changes: [{ file: "a.ts", patch: "fixture" }], omitted: [], dispose: async () => {} };
	},
	assertCurrent: async () => {},
}));
vi.mock("./runner.js", () => ({ review: async () => structuredClone(state.report) }));
vi.mock("./journal.js", () => ({
	createRunJournal: async () => ({ path: "/private-runtime/progress.json", close: async () => {} }),
}));
vi.mock("./plannotator.js", () => ({
	installedPlannotator: async () => "/installed",
	present: async (options: { progress: (text: string) => void }) => {
		state.progressCallback = options.progress;
		if (state.emitProgress) {
			options.progress(state.progressMessage);
			state.progressQueued = true;
			state.onProgressQueued?.();
		}
		await state.viewerWait;
		if (state.failViewer) throw new Error("fixture viewer failure");
		return structuredClone(state.browser);
	},
}));
vi.mock("./report.js", async (original) => ({
	...(await original<object>()),
	saveReport: vi.fn(async () => {
		if (state.failSave) throw new Error("fixture report save failed");
	}),
}));
function harness() {
	state.report = {
		version: 1,
		id: "fixture",
		repoId: "a".repeat(64),
		project: "Fixture",
		createdAt: "now",
		scope: { kind: "local" },
		baseline: null,
		head: null,
		fingerprint: "snapshot",
		profileHash: "profile",
		promptHashes: {},
		model: "fake",
		status: "complete",
		lenses: [],
		declined: [],
		clean: [],
		issues: [],
		omitted: [],
		changedFiles: 1,
		findings: [
			{
				id: "F1",
				reviewer: "Security",
				title: "Proposed risky fix",
				severity: "medium",
				file: "a.ts",
				side: "new",
				startLine: 1,
				endLine: 1,
				problem: "Fixture",
				suggestion: "Proposed change",
				rationale: "Fixture",
				evidence: [],
			},
		],
		groups: [["F1"]],
		ledger: [],
		elapsedMs: 0,
		usage: { input: 0, output: 0, cost: 0 },
		tasks: [
			{
				id: "review:security",
				stage: "review",
				name: "Security",
				files: ["a.ts"],
				reason: "fixture",
				state: "completed",
				queuedAt: 0,
				turns: 1,
				requests: 1,
				compactions: 0,
				retries: 0,
				activity: "done",
				updatedAt: 1,
				usage: { input: 0, output: 0, cost: 0 },
			},
		],
	} satisfies Report;
	state.failViewer = false;
	state.failSave = false;
	vi.mocked(saveReport).mockClear();
	state.captureFailures = 0;
	state.viewerWait = undefined;
	state.emitProgress = false;
	state.progressQueued = false;
	state.onProgressQueued = undefined;
	state.progressMessage = "Viewer preparing";
	state.progressCallback = undefined;
	const ui = uiHarness();
	const ctx = {
		cwd: "/fixture",
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "review-session" },
		ui: ui.ui,
		modelRegistry: { find: () => ({}), hasConfiguredAuth: () => true },
	} as unknown as ExtensionContext;
	let command: any, tool: any;
	const events = new Map<string, () => void>();
	const api = {
		events: { emit: vi.fn() },
		on(name: string, handler: () => void) {
			events.set(name, handler);
		},
		registerCommand(_name: string, value: unknown) {
			command = value;
		},
		registerTool(value: unknown) {
			tool = value;
		},
		sendMessage: vi.fn(),
	};
	extension(api as unknown as ExtensionAPI);
	return { api, ctx, command, tool, ui, events };
}
afterEach(() => vi.useRealTimers());
it.each(["command", "tool"])("registers only the saved report before the %s handoff", async (entry) => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "Explain F1" };
	let path: string;
	if (entry === "tool") {
		const result = await h.tool.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx);
		path = result.details.path;
	} else {
		await h.command.handler("", h.ctx);
		await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalledOnce());
		path = h.api.sendMessage.mock.calls[0]![0].details.path;
		expect(h.api.events.emit.mock.invocationCallOrder[0]).toBeLessThan(
			h.api.sendMessage.mock.invocationCallOrder[0]!,
		);
	}
	expect(h.api.events.emit).toHaveBeenCalledExactlyOnceWith("permissions:allow_session_files", {
		version: 1,
		sessionId: "review-session",
		paths: [path],
	});
	expect(path).toBe(`/private-runtime/repos/${"a".repeat(64)}/reports/fixture.json`);
	expect(vi.mocked(saveReport).mock.invocationCallOrder.at(-1)).toBeLessThan(
		h.api.events.emit.mock.invocationCallOrder[0]!,
	);
});
it("does not register a report when persistence fails", async () => {
	const h = harness();
	state.failSave = true;
	await expect(h.tool.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx)).rejects.toThrow(
		"fixture report save failed",
	);
	expect(h.api.events.emit).not.toHaveBeenCalled();
});
it("keeps the review result if optional permission integration fails", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	h.api.events.emit.mockImplementation(() => {
		throw new Error("fixture listener failure");
	});
	const result = await h.tool.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx);
	expect(result.details.path).toContain("/reports/fixture.json");
	expect(result.content[0].text).toContain("NO FIXES AUTHORIZED");
});
it("returns complete nested usage to the parent tool without zeroing cache counters", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	const measured = {
		input: 3,
		output: 5,
		cacheRead: 10000,
		cacheWrite: 1000,
		totalTokens: 11008,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
	};
	(state.report as Report).usage = providerUsage(measured, "first");
	const result = await h.tool.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx);
	expect(result.usage).toEqual(measured);
	expect(result.content[0].text).toContain("10000 cache read");
});
it.each(["cancel", "session_shutdown", "session_tree"])(
	"does not deliver queued progress after %s while work is still settling",
	async (action) => {
		vi.useFakeTimers();
		const h = harness(),
			outer = new AbortController(),
			onUpdate = vi.fn();
		let release!: () => void;
		state.viewerWait = new Promise((resolve) => {
			release = resolve;
		});
		state.emitProgress = true;
		state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
		const ready = new Promise<void>((resolve) => {
			state.onProgressQueued = resolve;
		});
		const pending = h.tool.execute("fixture", {}, outer.signal, onUpdate, h.ctx).then(
			() => false,
			() => true,
		);
		try {
			await ready;
			if (action === "cancel") await h.command.handler("cancel", h.ctx);
			else h.events.get(action)!();
			state.progressCallback?.("Late viewer URL must not appear");
			await vi.advanceTimersByTimeAsync(500);
			expect(outer.signal.aborted).toBe(false);
			expect(onUpdate).not.toHaveBeenCalled();
			expect(h.ui.state.notifications.some((note) => note.message.includes("Late viewer"))).toBe(false);
		} finally {
			release();
		}
		expect(await pending).toBe(true);
		expect(h.api.events.emit).not.toHaveBeenCalled();
	},
);
it("releases Pi's serial command loop so status opens before browser feedback", async () => {
	vi.useFakeTimers();
	const h = harness(),
		url = "http://127.0.0.1:19432";
	let release!: () => void;
	state.viewerWait = new Promise((resolve) => {
		release = resolve;
	});
	state.emitProgress = true;
	state.progressMessage = `Review findings in Plannotator: ${url}`;
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	const ready = new Promise<void>((resolve) => {
		state.onProgressQueued = resolve;
	});
	// Mirror Pi's idle loop: the next command cannot run until the previous handler returns.
	let queue = Promise.resolve();
	const processed: string[] = [];
	const send = (args: string) => {
		queue = queue.then(async () => {
			await h.command.handler(args, h.ctx);
			processed.push(args);
		});
		return queue;
	};
	void send("");
	try {
		await ready;
		expect(processed).toContain("");
		await vi.advanceTimersByTimeAsync(100);
		expect(h.ui.state.frames.some((frame) => frame.includes(url))).toBe(true);
		expect(h.ui.state.notifications.some((note) => note.message.includes(url))).toBe(true);
		expect(h.api.sendMessage).not.toHaveBeenCalled();
		h.ui.state.active!.handleInput!("cancel-key");
		await vi.advanceTimersByTimeAsync(100);
		expect(h.ui.state.widgets.get("pr-review")?.join("\n")).toContain(url);
		await send("status");
		await vi.advanceTimersByTimeAsync(0);
		expect(processed).toContain("status");
		expect(h.ui.state.active?.render(120).join("\n")).toContain(url);
		expect(h.api.sendMessage).not.toHaveBeenCalled();
		await send(""); // A second review must not replace the still-active first operation.
		expect(h.ui.state.notifications.some((note) => note.message.includes("already active"))).toBe(true);
	} finally {
		release();
		await queue;
	}
	await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalledOnce());
	expect(h.ui.state.active).toBeUndefined();
	await send("status");
	await vi.advanceTimersByTimeAsync(0);
	expect(h.ui.state.active?.render(120).join("\n")).toContain("Review complete");
	expect(h.ui.state.active?.render(120).join("\n")).not.toContain("Waiting for Plannotator feedback");
	h.events.get("session_shutdown")!();
});
it("does not publish a detached command result or viewer URL into a retired session", async () => {
	vi.useFakeTimers();
	const h = harness();
	let release!: () => void;
	state.viewerWait = new Promise((resolve) => {
		release = resolve;
	});
	state.emitProgress = true;
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	const ready = new Promise<void>((resolve) => {
		state.onProgressQueued = resolve;
	});
	await h.command.handler("", h.ctx);
	await ready;
	h.events.get("session_shutdown")!();
	state.progressCallback?.("Late browser URL");
	release();
	await vi.advanceTimersByTimeAsync(0);
	expect(h.api.sendMessage).not.toHaveBeenCalled();
	expect(h.api.events.emit).not.toHaveBeenCalled();
	expect(h.ui.state.notifications.some((note) => note.message.includes("Late browser"))).toBe(false);
	await h.command.handler("status", h.ctx);
	expect(h.ui.state.notifications.at(-1)?.message).toContain("No review task history");
	expect(vi.getTimerCount()).toBe(0);
});
it("keeps the review tool awaited while exposing live browser progress and status", async () => {
	vi.useFakeTimers();
	const h = harness(),
		onUpdate = vi.fn(),
		url = "http://127.0.0.1:19433";
	h.ctx.isIdle = () => false;
	let release!: () => void,
		settled = false;
	state.viewerWait = new Promise((resolve) => {
		release = resolve;
	});
	state.emitProgress = true;
	state.progressMessage = `Review findings in Plannotator: ${url}`;
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	const ready = new Promise<void>((resolve) => {
		state.onProgressQueued = resolve;
	});
	const pending = h.tool
		.execute("fixture", {}, new AbortController().signal, onUpdate, h.ctx)
		.then((result: unknown) => {
			settled = true;
			return result;
		});
	try {
		await ready;
		await vi.advanceTimersByTimeAsync(100);
		expect(settled).toBe(false);
		expect(onUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ content: [{ type: "text", text: expect.stringContaining(url) }] }),
		);
		h.ui.state.active!.handleInput!("cancel-key");
		await h.command.handler("status", h.ctx);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.ui.state.active?.render(120).join("\n")).toContain(url);
		expect(settled).toBe(false);
	} finally {
		release();
		await pending;
	}
	expect(settled).toBe(true);
});
it.each(["lgtm", "dismissed", "failure"])(
	"preserves no-fix authorization in the actual %s tool result",
	async (decision) => {
		const h = harness();
		state.browser = { decision, requestedIds: [], discussion: [], feedback: "" };
		state.failViewer = decision === "failure";
		const result = await h.tool.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx);
		expect(result.content[0].text).toContain("NO FIXES AUTHORIZED");
		expect(result.content[0].text).toContain("Requested verified finding IDs: []");
		expect(result.content[0].text).toContain("Proposed risky fix");
	},
);
it("allows status/retry during an agent-invoked review without rerunning completed stages", async () => {
	const h = harness();
	state.captureFailures = 1;
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	h.ctx.isIdle = () => false;
	const pending = h.tool.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx);
	await vi.waitFor(() => expect(h.ui.state.frames.some((frame) => frame.includes("Blocked"))).toBe(true));
	await h.command.handler("status", h.ctx);
	await h.command.handler("retry", h.ctx);
	const result = await pending;
	expect(result.content[0].text).toContain("NO FIXES AUTHORIZED");
	expect(h.ui.state.active).toBeUndefined();
});
it("cancels a blocked tool review through the command without an idle session", async () => {
	const h = harness();
	state.captureFailures = 1;
	h.ctx.isIdle = () => false;
	const pending = expect(
		h.tool.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx),
	).rejects.toThrow();
	await vi.waitFor(() => expect(h.ui.state.frames.some((frame) => frame.includes("Blocked"))).toBe(true));
	await h.command.handler("cancel", h.ctx);
	await pending;
	expect(h.ui.state.active).toBeUndefined();
});
it("triggers discussion for command approval notes without authorizing fixes", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "Please explain F1." };
	await h.command.handler("", h.ctx);
	await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalled());
	expect(h.api.sendMessage).toHaveBeenCalledWith(
		expect.objectContaining({ content: expect.stringContaining("NO FIXES AUTHORIZED") }),
		{ triggerTurn: true },
	);
	expect(h.api.sendMessage.mock.calls[0]![0].content).toContain("browser.feedback");
});
it("retains a visible report locator for a truncated command result", async () => {
	const h = harness();
	state.browser = {
		decision: "lgtm",
		requestedIds: [],
		discussion: [],
		feedback: "LGTM - no changes requested.",
	};
	(state.report as Report).issues = ["long report\n".repeat(12000)];
	await h.command.handler("", h.ctx);
	await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalled());
	const text = h.api.sendMessage.mock.calls[0]![0].content;
	expect(text).toContain("Display truncated");
	expect(text).toContain("NO FIXES AUTHORIZED");
	expect(text).toMatch(/Full structured report: .*\/reports\/fixture\.json$/);
	expect(h.api.sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: false });
});
