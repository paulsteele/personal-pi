import { afterEach, describe, expect, it, vi } from "vitest";
import { AtelierRuntime } from "../src/state.js";

afterEach(() => {
	vi.useRealTimers();
});

const assistant = {
	type: "message",
	message: {
		role: "assistant",
		usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, cost: { total: 0.01 } },
	},
};

const cleanInspection = {
	kind: "available" as const,
	root: "/repo",
	relativeCwd: "",
	branch: "main",
	snapshot: {
		trackedFiles: 0,
		untrackedFiles: 0,
		linesAdded: 0,
		linesRemoved: 0,
		binaryFiles: 0,
		submodules: 0,
		conflicts: 0,
	},
};

function createRuntime(
	execResult = { stdout: "", stderr: "", code: 0, killed: false },
	random: () => number = Math.random,
	inspectWorkspace = vi.fn().mockResolvedValue(cleanInspection),
) {
	const requestRender = vi.fn();
	const exec = vi.fn().mockResolvedValue(execResult);
	const ctx = {
		model: { id: "model", provider: "provider", reasoning: true },
		modelRegistry: { isUsingOAuth: vi.fn().mockReturnValue(true) },
		getContextUsage: vi.fn().mockReturnValue({ tokens: 1_000, contextWindow: 10_000, percent: 10 }),
		sessionManager: { getEntries: vi.fn().mockReturnValue([assistant]) },
	};
	const runtime = new AtelierRuntime({
		pi: { exec } as never,
		ctx: ctx as never,
		autoCompact: true,
		random,
		requestRender,
		inspectWorkspace,
	});
	return { runtime, exec, requestRender, inspectWorkspace, ctx };
}

describe("AtelierRuntime", () => {
	it("derives metrics without retaining message content", () => {
		const { runtime } = createRuntime();
		runtime.refreshUsage();
		expect(runtime.getState()).toMatchObject({
			modelId: "model",
			provider: "provider",
			metrics: { input: 100, output: 20, cacheRead: 900, subscription: true, autoCompact: true },
		});
		expect(JSON.stringify(runtime.getState())).not.toContain("content");
	});

	it("starts inspecting and derives clean or changed Pulse states from successful inspection", async () => {
		const changed = {
			...cleanInspection,
			branch: "feature/pulse",
			snapshot: { ...cleanInspection.snapshot, trackedFiles: 2, linesAdded: 12, linesRemoved: 3 },
		};
		const inspectWorkspace = vi.fn().mockResolvedValue(changed);
		const { runtime } = createRuntime(undefined, Math.random, inspectWorkspace);

		expect(runtime.getState()).toMatchObject({ workspacePulse: { status: "inspecting" } });
		await runtime.flushWorkspacePulseRefresh();

		expect(runtime.getState()).toMatchObject({
			branch: "feature/pulse",
			dirty: true,
			workspacePulse: {
				status: "changed",
				data: { branch: "feature/pulse", root: "/repo", snapshot: changed.snapshot },
			},
		});
	});

	it("keeps the Footer dirty marker tracked-only for an untracked-only Pulse", async () => {
		const untrackedOnly = {
			...cleanInspection,
			snapshot: { ...cleanInspection.snapshot, untrackedFiles: 2 },
		};
		const { runtime } = createRuntime(undefined, Math.random, vi.fn().mockResolvedValue(untrackedOnly));

		await runtime.flushWorkspacePulseRefresh();

		expect(runtime.getState()).toMatchObject({
			dirty: false,
			workspacePulse: { status: "changed", data: { snapshot: { untrackedFiles: 2 } } },
		});
	});

	it("preserves the last successful Pulse as stale when a later inspection fails", async () => {
		const inspectWorkspace = vi
			.fn()
			.mockResolvedValueOnce(cleanInspection)
			.mockResolvedValueOnce({ kind: "unavailable" });
		const { runtime } = createRuntime(undefined, Math.random, inspectWorkspace);

		await runtime.flushWorkspacePulseRefresh();
		await runtime.flushWorkspacePulseRefresh();

		expect(runtime.getState()).toMatchObject({
			branch: "main",
			dirty: false,
			workspacePulse: {
				status: "stale",
				data: { branch: "main", root: "/repo", snapshot: cleanInspection.snapshot },
			},
		});
	});

	it("does not invalidate rendering when a refresh confirms the same Pulse", async () => {
		const inspectWorkspace = vi.fn().mockResolvedValue(cleanInspection);
		const { runtime, requestRender } = createRuntime(undefined, Math.random, inspectWorkspace);
		await runtime.flushWorkspacePulseRefresh();
		requestRender.mockClear();

		await runtime.flushWorkspacePulseRefresh();

		expect(requestRender).not.toHaveBeenCalled();
	});

	it("reports context-free inert state once disposed without consulting the retired context", async () => {
		const { runtime, ctx } = createRuntime();
		runtime.setActivity("working");
		await runtime.flushWorkspacePulseRefresh();
		expect(runtime.getState()).toMatchObject({
			activity: "working",
			branch: "main",
			metrics: { contextTokens: 1_000, contextWindow: 10_000, contextPercent: 10 },
		});
		ctx.getContextUsage.mockImplementation(() => {
			throw new Error("retired context is unavailable");
		});

		expect(() => runtime.dispose()).not.toThrow();

		const state = runtime.getState();
		expect(state.branch).toBeUndefined();
		expect(state.workingLabel).toBeUndefined();
		expect(state.activity).toBe("ready");
		expect(state.dirty).toBe(false);
		expect(state.extensionStatuses).toEqual([]);
		expect(state.metrics).toMatchObject({
			usageAvailable: false,
			costAvailable: false,
			contextTokens: null,
			contextWindow: 0,
			contextPercent: null,
		});
		expect(state.workspacePulse).toEqual({ status: "unavailable" });
	});

	it("selects one stable label when a work cycle starts", () => {
		const random = vi.fn().mockReturnValue(0.5);
		const { runtime, requestRender } = createRuntime(undefined, random);
		requestRender.mockClear();

		runtime.setActivity("working");
		const selected = runtime.getState().workingLabel;
		runtime.setActivity("working");
		runtime.refreshUsage();

		expect(selected).toBe("PONDERING");
		expect(runtime.getState()).toMatchObject({ activity: "working", workingLabel: "PONDERING" });
		expect(random).toHaveBeenCalledOnce();
		expect(requestRender).toHaveBeenCalledTimes(2);
	});
});
