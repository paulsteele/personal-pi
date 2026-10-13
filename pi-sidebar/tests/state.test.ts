import { afterEach, describe, expect, it, vi } from "vitest";
import { AtelierRuntime, SidebarRuntime } from "../src/state.js";

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
		requestRender,
		inspectWorkspace,
	});
	return { runtime, exec, requestRender, inspectWorkspace, ctx };
}

function sandboxPulseFixture() {
	const execute = vi.fn(
		async (_options: { command: string[]; timeoutMs?: number; signal?: AbortSignal }) => ({
			output: Buffer.alloc(0),
			stderr: "",
			code: 0,
		}),
	);
	execute.mockResolvedValueOnce({ output: Buffer.from("true\n/repo\n"), stderr: "", code: 0 });
	execute.mockResolvedValueOnce({
		output: Buffer.from("# branch.oid abc\0# branch.head main\0"),
		stderr: "",
		code: 0,
	});
	execute.mockResolvedValueOnce({ output: Buffer.from("tree\n"), stderr: "", code: 0 });
	const runtime = new SidebarRuntime({
		pi: {
			events: {
				emit(_channel: string, request: { accept(value: unknown): void }) {
					request.accept({ session: { environment: { workspace: "/repo" }, execute } });
				},
			},
		} as never,
		ctx: {
			modelRegistry: {},
			getContextUsage: () => undefined,
			sessionManager: { getEntries: () => [] },
		} as never,
		autoCompact: null,
		requestRender: vi.fn(),
	});
	return { runtime, execute };
}

it("forwards every Workspace Pulse deadline to guest execution and retains stale telemetry on timeout", async () => {
	const fixture = sandboxPulseFixture();
	try {
		await fixture.runtime.flushWorkspacePulseRefresh();
		expect(fixture.runtime.getState().workspacePulse.status).toBe("clean");
		expect(fixture.execute).toHaveBeenCalledTimes(4);
		for (const [options] of fixture.execute.mock.calls) {
			expect(options.timeoutMs).toBe(2000);
			expect(options.signal).toBeInstanceOf(AbortSignal);
		}
		fixture.execute.mockRejectedValueOnce(new Error("Guest process timed out"));
		await fixture.runtime.flushWorkspacePulseRefresh();
		expect(fixture.runtime.getState().workspacePulse).toMatchObject({
			status: "stale",
			data: { branch: "main" },
		});
	} finally {
		fixture.runtime.dispose();
	}
});

it("cancels a pending guest Workspace Pulse probe when Sidebar retires", async () => {
	const fixture = sandboxPulseFixture();
	fixture.execute.mockReset();
	fixture.execute.mockImplementation(
		async (options) =>
			new Promise((_resolve, reject) => {
				options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
			}),
	);
	const pending = fixture.runtime.flushWorkspacePulseRefresh();
	await vi.waitFor(() => expect(fixture.execute).toHaveBeenCalledOnce());
	fixture.runtime.dispose();
	await pending;
	expect(fixture.execute.mock.calls[0]![0].signal!.aborted).toBe(true);
	expect(fixture.runtime.getState().workspacePulse.status).toBe("unavailable");
});

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

	it.each(["pr_review", "codemode"])("includes %s model usage from its persisted tool result", (toolName) => {
		const { runtime, ctx } = createRuntime();
		ctx.sessionManager.getEntries.mockReturnValue([
			assistant,
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName,
					content: [{ type: "text", text: "Private tool output" }],
					usage: { input: 200, output: 40, cacheRead: 0, cacheWrite: 50, cost: { total: 0.02 } },
					nestedCalls: { calls: [{ id: "parent/1", name: "read", status: "ok" }], complete: true },
				},
			},
		] as never);

		runtime.refreshUsage();

		expect(runtime.getState().metrics).toMatchObject({
			input: 300,
			output: 60,
			cacheRead: 900,
			cacheWrite: 50,
			cacheHitPercent: 90,
		});
		expect(runtime.getState().metrics.cost).toBeCloseTo(0.03);
		expect(JSON.stringify(runtime.getState())).not.toContain("Private tool output");
	});

	it("starts inspecting and derives clean or changed Pulse states from successful inspection", async () => {
		const changed = {
			...cleanInspection,
			branch: "feature/pulse",
			snapshot: { ...cleanInspection.snapshot, trackedFiles: 2, linesAdded: 12, linesRemoved: 3 },
		};
		const inspectWorkspace = vi.fn().mockResolvedValue(changed);
		const { runtime } = createRuntime(undefined, inspectWorkspace);

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
		const { runtime } = createRuntime(undefined, vi.fn().mockResolvedValue(untrackedOnly));

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
		const { runtime } = createRuntime(undefined, inspectWorkspace);

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
		const { runtime, requestRender } = createRuntime(undefined, inspectWorkspace);
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

	it("tracks working activity without decorative labels", () => {
		const { runtime, requestRender } = createRuntime();
		requestRender.mockClear();

		runtime.setActivity("working");
		runtime.setActivity("working");
		runtime.refreshUsage();

		expect(runtime.getState()).toMatchObject({ activity: "working" });
		expect(requestRender).toHaveBeenCalledTimes(2);
	});
});
