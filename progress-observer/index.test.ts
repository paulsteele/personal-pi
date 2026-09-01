import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import progressObserver from "./index.js";

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
				arguments: { goal: "Goal", progress: "Done", current: "Now", next: "Next" },
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
		hasUI: mode === "tui",
		ui: { notify: vi.fn(), select: vi.fn() },
		modelRegistry: {
			find: vi.fn().mockReturnValue(model),
			hasConfiguredAuth: vi.fn().mockReturnValue(true),
			complete,
			getAvailable: vi.fn().mockReturnValue([model, { provider: "openai", id: "small" }]),
		},
		sessionManager: {
			buildContextEntries: vi.fn().mockReturnValue(entries),
			getLeafId: vi.fn().mockReturnValue("leaf-1"),
		},
	};
	progressObserver(pi as never);
	return { agentDir, handlers, commands, emitted, complete, ctx };
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
	it("runs fire-and-forget on the first TUI turn and publishes ready state", async () => {
		const h = harness();
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		await h.handlers.get("turn_end")?.({ turnIndex: 0 }, h.ctx);
		await flush();
		expect(h.complete).toHaveBeenCalledTimes(1);
		expect(h.emitted.filter(([channel]) => channel === "progress-observer:state").at(-1)?.[1]).toMatchObject({
			phase: "ready",
			summary: { goal: "Goal" },
		});
	});

	it("stays inert outside TUI mode", async () => {
		const h = harness("print");
		await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		await h.handlers.get("turn_end")?.({ turnIndex: 0 }, h.ctx);
		await flush();
		expect(h.complete).not.toHaveBeenCalled();
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
