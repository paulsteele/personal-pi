import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { observe } from "./observer.js";
import type { ObserverSnapshot } from "./events.js";
import { DEFAULT_CONFIG } from "./config.js";
import { createObserverScheduler } from "./scheduler.js";

const summary = { goal: "Goal", progress: "Done", current: "Now", next: "Next" };

function progressResponse(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 0,
		content: [{ type: "toolCall", id: "progress", name: "submit_progress", arguments: summary }],
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

afterEach(() => vi.useRealTimers());

describe("observer scheduler", () => {
	it("runs at four-turn lap boundaries, then by lap or age", async () => {
		let time = 1_000;
		let revision = 0;
		const nextRevision = () => `r${++revision}`;
		const states: any[] = [];
		const run = vi.fn().mockResolvedValue({ kind: "success", summary });
		const scheduler = createObserverScheduler({
			config: DEFAULT_CONFIG,
			modelId: "litellm/luna",
			onState: (state) => states.push(state),
			run,
			now: () => time,
		});
		expect(states.at(-1)?.phase).toBe("waiting");
		for (let index = 0; index < 3; index += 1) scheduler.turnEnded(nextRevision());
		await flush();
		expect(run).not.toHaveBeenCalled();
		scheduler.turnEnded(nextRevision());
		await flush();
		expect(run).toHaveBeenCalledTimes(1);
		for (let index = 0; index < 3; index += 1) scheduler.turnEnded(nextRevision());
		await flush();
		expect(run).toHaveBeenCalledTimes(1);
		scheduler.turnEnded(nextRevision());
		await flush();
		expect(run).toHaveBeenCalledTimes(2);
		time += DEFAULT_CONFIG.maxAgeMs;
		scheduler.turnEnded(nextRevision());
		await flush();
		expect(run).toHaveBeenCalledTimes(3);
	});

	it("skips a due refresh when session activity has not changed", async () => {
		let time = 1_000;
		const run = vi.fn().mockResolvedValue({ kind: "success", summary });
		const scheduler = createObserverScheduler({
			config: DEFAULT_CONFIG,
			modelId: "model",
			onState: () => undefined,
			run,
			now: () => time,
		});
		for (let index = 0; index < DEFAULT_CONFIG.turnInterval; index += 1) scheduler.turnEnded("same-leaf");
		await flush();
		time += DEFAULT_CONFIG.maxAgeMs;
		scheduler.turnEnded("same-leaf");
		await flush();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("coalesces in-flight triggers and keeps the newest generation", async () => {
		let resolve!: (value: any) => void;
		const first = new Promise<any>((done) => (resolve = done));
		const run = vi.fn().mockReturnValueOnce(first).mockResolvedValue({ kind: "success", summary });
		const states: any[] = [];
		const scheduler = createObserverScheduler({
			config: { ...DEFAULT_CONFIG, turnInterval: 1 },
			modelId: "model",
			onState: (state) => states.push(state),
			run,
		});
		scheduler.turnEnded("r1");
		scheduler.turnEnded("r2");
		scheduler.turnEnded("r3");
		expect(run).toHaveBeenCalledTimes(1);
		resolve({ kind: "success", summary });
		await flush();
		expect(run).toHaveBeenCalledTimes(2);
		expect(states.at(-1)?.phase).toBe("ready");
	});

	it("releases a timed-out observation for the queued latest refresh while retaining the last summary", async () => {
		vi.useFakeTimers();
		const model: Model<Api> = {
			id: "observer",
			name: "Observer fixture",
			api: "openai-responses",
			provider: "test",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 1_000,
		};
		const response = progressResponse(model);
		let finishTimedOutRequest!: (response: AssistantMessage) => void;
		let finishLatestRequest!: (response: AssistantMessage) => void;
		const complete = vi
			.fn<() => Promise<AssistantMessage>>()
			.mockResolvedValueOnce(response)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishTimedOutRequest = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishLatestRequest = resolve;
					}),
			);
		const states: ObserverSnapshot[] = [];
		const config = { ...DEFAULT_CONFIG, turnInterval: 1, timeoutMs: 250 };
		const scheduler = createObserverScheduler({
			config,
			modelId: "test/observer",
			onState: (state) => states.push(state),
			run: (signal) => observe({ caller: { complete }, model, prompt: "record", config, signal }),
		});
		try {
			scheduler.turnEnded("r1");
			await vi.advanceTimersByTimeAsync(0);
			expect(states.at(-1)).toMatchObject({ phase: "ready", summary });
			scheduler.turnEnded("r2");
			scheduler.turnEnded("r3");
			scheduler.turnEnded("r4");
			expect(complete).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(250);
			expect(states).toContainEqual(expect.objectContaining({ phase: "error", stale: true, summary }));
			expect(complete).toHaveBeenCalledTimes(3);
			expect(states.at(-1)).toMatchObject({ phase: "observing", stale: true, summary });
			finishLatestRequest(response);
			await vi.advanceTimersByTimeAsync(0);
			expect(states.at(-1)).toMatchObject({ phase: "ready", summary });
			const publishedCount = states.length;
			finishTimedOutRequest({ ...response, content: [] });
			await vi.advanceTimersByTimeAsync(0);
			expect(states).toHaveLength(publishedCount);
			scheduler.turnEnded("r4");
			await vi.advanceTimersByTimeAsync(0);
			expect(complete).toHaveBeenCalledTimes(3);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			scheduler.dispose();
		}
	});

	it("retains the last summary on failure and rejects retired results", async () => {
		let resolve!: (value: any) => void;
		const pending = new Promise<any>((done) => (resolve = done));
		const states: any[] = [];
		const run = vi
			.fn()
			.mockResolvedValueOnce({ kind: "success", summary })
			.mockResolvedValueOnce({ kind: "error", message: "failed" })
			.mockReturnValueOnce(pending);
		const scheduler = createObserverScheduler({
			config: { ...DEFAULT_CONFIG, turnInterval: 1 },
			modelId: "model",
			onState: (state) => states.push(state),
			run,
		});
		scheduler.turnEnded("r1");
		await flush();
		scheduler.turnEnded("r2");
		await flush();
		expect(states.at(-1)).toMatchObject({ phase: "error", stale: true, summary });
		scheduler.turnEnded("r3");
		scheduler.reset();
		resolve({ kind: "success", summary: { ...summary, goal: "stale" } });
		await flush();
		expect(states.at(-1)?.phase).toBe("waiting");
		expect(states.at(-1)?.summary).toBeUndefined();
	});
});
