import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";
import { createObserverScheduler } from "./scheduler.js";

const summary = { goal: "Goal", progress: "Done", current: "Now", next: "Next" };
const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("observer scheduler", () => {
	it("runs after the first turn, then at five turns or two minutes", async () => {
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
		scheduler.turnEnded(nextRevision());
		await flush();
		expect(run).toHaveBeenCalledTimes(1);
		for (let index = 0; index < 4; index += 1) scheduler.turnEnded(nextRevision());
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
		scheduler.turnEnded("same-leaf");
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
