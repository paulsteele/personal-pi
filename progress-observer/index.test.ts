import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { discoverSettingsSections } from "@paulsteele/pi-shared-ui";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import progressObserver from "./index.js";
import { configPath, DEFAULT_CONFIG, saveConfig } from "./config.js";

const dirs: string[] = [];
function harness(mode: "tui" | "print" = "tui") {
	const agentDir = mkdtempSync(join(tmpdir(), "progress-observer-index-"));
	dirs.push(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const commands = new Map<string, any>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const emitted: Array<[string, unknown]> = [];
	const complete = vi.fn().mockResolvedValue({
		content: [
			{
				type: "toolCall",
				name: "submit_progress",
				arguments: { goal: "Goal", changed: "Done", current: "Now", next: "Next" },
			},
		],
		stopReason: "stop",
	});
	const model = { provider: "litellm", id: "amod-gpt-5.6-luna" };
	const pi = {
		on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				const current = listeners.get(channel) ?? new Set();
				current.add(handler);
				listeners.set(channel, current);
				return () => current.delete(handler);
			},
			emit(channel: string, data: unknown) {
				emitted.push([channel, data]);
				for (const handler of listeners.get(channel) ?? []) handler(data);
			},
		},
	};
	const entries = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "Do work" }] } },
	];
	const ctx = {
		mode,
		isIdle: vi.fn().mockReturnValue(false),
		hasUI: mode === "tui",
		ui: { notify: vi.fn(), select: vi.fn() },
		modelRegistry: {
			find: vi.fn().mockReturnValue(model),
			hasConfiguredAuth: vi.fn().mockReturnValue(true),
			complete,
			getAvailable: vi.fn().mockReturnValue([model, { provider: "openai", id: "small" }]),
		},
		sessionManager: {
			getSessionId: vi.fn().mockReturnValue("observer-session"),
			buildContextEntries: vi.fn().mockReturnValue(entries),
			getLeafId: vi.fn().mockReturnValue("leaf-1"),
		},
	};
	progressObserver(pi as never);
	return { agentDir, handlers, commands, emitted, complete, ctx, pi };
}

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("progress observer extension", () => {
	it("retains the saved owner across refresh, resume, reload, and tree navigation", async () => {
		const h = harness();
		for (const reason of ["startup", "resume", "reload"]) {
			await h.handlers.get("session_start")?.({ reason }, h.ctx);
			await h.commands.get("observer").handler("refresh", h.ctx);
			await flush();
		}
		await h.handlers.get("session_tree")?.({}, h.ctx);
		await flush();
		expect(h.complete.mock.calls.length).toBeGreaterThanOrEqual(4);
		expect(h.complete.mock.calls.map((call) => call[2].headers["x-litellm-trace-id"])).toEqual(
			Array(h.complete.mock.calls.length).fill("pi-observer-session-activity"),
		);
		await h.handlers.get("session_shutdown")?.({}, h.ctx);
	});

	it.each(["new", "fork", "clone", "switch"])(
		"captures a fresh owner on %s without relabeling a pending observation",
		async (reason) => {
			const h = harness();
			let resolvePendingObservation!: (value: unknown) => void;
			h.complete.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolvePendingObservation = resolve;
					}),
			);
			await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
			await h.commands.get("observer").handler("refresh", h.ctx);
			await flush();
			h.ctx.sessionManager.getSessionId.mockReturnValue("replacement-session");
			await h.handlers.get("session_start")?.({ reason }, h.ctx);
			await h.commands.get("observer").handler("refresh", h.ctx);
			await flush();
			resolvePendingObservation({ content: [], stopReason: "stop" });
			await flush();
			expect(h.complete.mock.calls[0]![2].headers).toEqual({
				"x-litellm-trace-id": "pi-observer-session-activity",
			});
			expect(
				h.complete.mock.calls
					.slice(1)
					.every((call) => call[2].headers["x-litellm-trace-id"] === "pi-replacement-session-activity"),
			).toBe(true);
			expect(h.complete.mock.calls.length).toBeGreaterThan(1);
			await h.handlers.get("session_shutdown")?.({}, h.ctx);
		},
	);

	it("runs fire-and-forget at the first four-turn lap boundary and publishes ready state", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		const turnEndEvent = (turnIndex: number) => ({
			turnIndex,
			message: { role: "assistant" as const, content: [] },
			toolResults: [],
		});
		for (let turnIndex = 0; turnIndex < 3; turnIndex += 1) {
			await h.handlers.get("turn_end")?.(turnEndEvent(turnIndex), h.ctx);
		}
		await flush();
		expect(h.complete).not.toHaveBeenCalled();
		await h.handlers.get("turn_end")?.(turnEndEvent(3), h.ctx);
		await flush();
		expect(h.complete).toHaveBeenCalledTimes(1);
		expect(h.emitted.filter(([channel]) => channel === "progress-observer:state").at(-1)?.[1]).toMatchObject({
			phase: "ready",
			summary: { goal: "Goal" },
		});
	});

	it("refreshes after final settlement without waiting for four turns", async () => {
		vi.useFakeTimers();
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		h.ctx.isIdle.mockReturnValue(true);
		await h.handlers.get("agent_settled")?.({ aborted: false }, h.ctx);
		expect(h.complete).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(750);
		expect(h.complete).toHaveBeenCalledTimes(1);
		expect(h.complete.mock.calls[0]![1].messages[0].content).toContain("Agent is idle");
		await h.handlers.get("agent_settled")?.({ aborted: false }, h.ctx);
		await vi.advanceTimersByTimeAsync(750);
		expect(h.complete).toHaveBeenCalledTimes(1);
		await h.handlers.get("session_shutdown")?.({}, h.ctx);
		vi.useRealTimers();
	});

	it("refreshes idle state even when the final turn revision was already observed", async () => {
		vi.useFakeTimers();
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		await h.commands.get("observer").handler("refresh", h.ctx);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.complete).toHaveBeenCalledTimes(1);
		h.ctx.isIdle.mockReturnValue(true);
		await h.handlers.get("agent_settled")?.({ aborted: false }, h.ctx);
		await vi.advanceTimersByTimeAsync(750);
		expect(h.complete).toHaveBeenCalledTimes(2);
		expect(h.complete.mock.calls[1]![1].messages[0].content).toContain("Agent is idle");
		await h.handlers.get("session_shutdown")?.({}, h.ctx);
		vi.useRealTimers();
	});

	it("compares new activity with the boundary captured by the previous successful request", async () => {
		const h = harness();
		h.ctx.sessionManager.buildContextEntries.mockReturnValue([
			{ id: "leaf-1", type: "message", message: { role: "user", content: "Do work" } },
		] as never);
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		await h.commands.get("observer").handler("refresh", h.ctx);
		await vi.waitFor(() => expect(h.emitted.at(-1)?.[1]).toMatchObject({ phase: "ready" }));
		h.ctx.sessionManager.getLeafId.mockReturnValue("leaf-2");
		h.ctx.sessionManager.buildContextEntries.mockReturnValue([
			{ id: "leaf-1", type: "message", message: { role: "user", content: "Do work" } },
			{ id: "leaf-2", type: "message", message: { role: "assistant", content: "Added resume fixture" } },
		] as never);
		await h.commands.get("observer").handler("refresh", h.ctx);
		await vi.waitFor(() => expect(h.complete).toHaveBeenCalledTimes(2));
		expect(h.complete.mock.calls[1]![1].messages[0].content).toContain(
			"NEW: assistant: Added resume fixture",
		);
		await h.handlers.get("session_shutdown")?.({}, h.ctx);
	});

	it("stays inert outside TUI mode", async () => {
		const h = harness("print");
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		await h.handlers.get("turn_end")?.({ turnIndex: 0 }, h.ctx);
		await flush();
		expect(h.complete).not.toHaveBeenCalled();
	});

	it("disables observation without requiring a replacement for an unavailable saved model", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		h.ctx.modelRegistry.getAvailable.mockReturnValue([]);
		const section = discoverSettingsSections(h.pi).find((section) => section.id === "observer")!;
		const draft = await section.load(h.ctx as never);
		await draft.apply({ ...draft.value, enabledByDefault: false });
		expect(
			JSON.parse(readFileSync(join(h.agentDir, "extensions/progress-observer/config.json"), "utf8")),
		).toMatchObject({ enabledByDefault: false });
		expect(h.complete).not.toHaveBeenCalled();
	});

	it("saves an unset model as the default even when no models are available", async () => {
		const h = harness();
		saveConfig(h.agentDir, {
			...DEFAULT_CONFIG,
			provider: "removed",
			model: "old-model",
			enabledByDefault: false,
		});
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		h.ctx.modelRegistry.getAvailable.mockReturnValue([]);
		const section = discoverSettingsSections(h.pi).find((section) => section.id === "observer")!;
		const draft = await section.load(h.ctx as never);
		const { modelSelection: _selection, ...settings } = draft.value;
		await draft.apply(settings);
		expect(JSON.parse(readFileSync(configPath(h.agentDir), "utf8"))).toMatchObject({
			provider: DEFAULT_CONFIG.provider,
			model: DEFAULT_CONFIG.model,
			enabledByDefault: false,
		});
		expect(h.complete).not.toHaveBeenCalled();
	});

	it("rejects an explicit replacement model that is unavailable", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		h.ctx.modelRegistry.getAvailable.mockReturnValue([]);
		const section = discoverSettingsSections(h.pi).find((section) => section.id === "observer")!;
		const draft = await section.load(h.ctx as never);
		await expect(draft.apply({ ...draft.value, modelSelection: "removed/replacement" })).rejects.toThrow(
			"available observer model",
		);
		expect(h.complete).not.toHaveBeenCalled();
	});

	it("rejects stale settings without restarting observation or overwriting the newer off choice", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		const section = discoverSettingsSections(h.pi).find((section) => section.id === "observer")!;
		const first = await section.load(h.ctx as never);
		await first.apply({ ...first.value, enabledByDefault: false });
		const stale = await section.load(h.ctx as never);
		const path = join(h.agentDir, "extensions/progress-observer/config.json");
		const changed = { ...JSON.parse(readFileSync(path, "utf8")), timeoutMs: 1000 };
		writeFileSync(path, JSON.stringify(changed));
		await expect(stale.apply({ ...stale.value, turnInterval: 10 })).rejects.toThrow("changed outside");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(changed);
	});

	it("retains the previous inference as stale when a settings-triggered refresh fails", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		await h.commands.get("observer").handler("refresh", h.ctx);
		await vi.waitFor(() =>
			expect(
				h.emitted.filter(([channel]) => channel === "progress-observer:state").at(-1)?.[1],
			).toMatchObject({ phase: "ready" }),
		);
		h.complete.mockRejectedValueOnce(new Error("Observer provider unavailable"));
		const section = discoverSettingsSections(h.pi).find((section) => section.id === "observer")!;
		const draft = await section.load(h.ctx as never);
		await draft.apply({ ...draft.value, timeoutMs: 1000 });
		await vi.waitFor(() =>
			expect(
				h.emitted.filter(([channel]) => channel === "progress-observer:state").at(-1)?.[1],
			).toMatchObject({
				phase: "error",
				stale: true,
				summary: { goal: "Goal", changed: "Done" },
			}),
		);
		await h.handlers.get("session_shutdown")?.({}, h.ctx);
	});

	it("supports persistent toggles, manual refresh, and model selection", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		await h.commands.get("observer").handler("off", h.ctx);
		await h.commands.get("observer").handler("on", h.ctx);
		await h.commands.get("observer").handler("refresh", h.ctx);
		await flush();
		expect(h.complete).toHaveBeenCalledTimes(1);
		await h.commands.get("observer-model").handler("openai/small", h.ctx);
		await flush();
		expect(h.ctx.modelRegistry.find).toHaveBeenLastCalledWith("openai", "small");
	});
});
