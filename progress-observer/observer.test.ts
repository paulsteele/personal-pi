import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Context, Model, StreamOptions, ToolCall } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG } from "./config.js";
import { buildObservationPrompt, observe } from "./observer.js";

type Complete = (model: Model<Api>, context: Context, options?: StreamOptions) => Promise<AssistantMessage>;
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
const source = (entries: unknown[]) => ({ buildContextEntries: () => entries });
const summaryCall = (
	overrides: Record<string, unknown> = {},
): AssistantMessage & { content: ToolCall[] } => ({
	role: "assistant",
	api: model.api,
	provider: model.provider,
	model: model.id,
	timestamp: 0,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	content: [
		{
			type: "toolCall",
			id: "progress",
			name: "submit_progress",
			arguments: {
				goal: "Ship observer",
				progress: "Config is complete",
				current: "Writing tests",
				next: "Run checks",
				...overrides,
			},
		},
	],
	stopReason: "stop",
});

afterEach(() => vi.useRealTimers());

describe("observer prompt", () => {
	it("uses compaction-aware entries, excludes thinking/images, and redacts secrets", () => {
		const prompt = buildObservationPrompt(
			source([
				{ type: "compaction", summary: "Earlier work", retainedTail: [] },
				{
					type: "message",
					message: {
						role: "user",
						content: [
							{ type: "text", text: "Use token=ghp_abcdefghijklmnopqrstuvwxyz" },
							{ type: "image", data: "private-image" },
						],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "hidden plan" },
							{ type: "text", text: "Inspecting files" },
							{
								type: "toolCall",
								name: "bash",
								arguments: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop'", content: "omit" },
							},
						],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "bash",
						isError: false,
						content: [{ type: "text", text: "password=hunter2 done" }],
					},
				},
			]),
		);
		expect(prompt).toContain("Earlier work");
		expect(prompt).toContain("tool call: bash");
		expect(prompt).toContain("tool result: bash succeeded");
		expect(prompt).toContain("[redacted]");
		expect(prompt).not.toContain("hidden plan");
		expect(prompt).not.toContain("private-image");
		expect(prompt).not.toContain("hunter2");
		expect(prompt.length).toBeLessThanOrEqual(24_000);
	});

	it("does not frame the request in meta-commentary vocabulary", () => {
		const prompt = buildObservationPrompt(
			source([{ type: "message", message: { role: "user", content: "Add fixtures" } }]),
			{ goal: "Goal", progress: "Done", current: "Now" },
		);
		expect(prompt).not.toMatch(/evidence/i);
		expect(prompt).toContain("Report the current state of this work.");
		expect(prompt).toContain("PREVIOUS REPORT");
	});
});

describe("observer model call", () => {
	it.each([
		{ provider: "litellm", piSessionId: "parent /雪", trace: "pi-parent%20%2F%E9%9B%AA-activity" },
		{ provider: "litellm", piSessionId: undefined, trace: undefined },
		{ provider: "openai", piSessionId: "parent", trace: undefined },
		{ provider: "litellm-alias", piSessionId: "parent", trace: undefined },
	])(
		"scopes activity tracking to $provider with owner $piSessionId",
		async ({ provider, piSessionId, trace }) => {
			const complete = vi.fn<Complete>().mockResolvedValue(summaryCall());
			const requestModel = { ...model, provider };
			await observe({
				caller: { complete },
				model: requestModel,
				piSessionId,
				prompt: "record",
				config: DEFAULT_CONFIG,
			});
			expect(complete.mock.calls[0]![2]?.headers).toEqual(
				trace ? { "x-litellm-trace-id": trace } : undefined,
			);
			expect(complete.mock.calls[0]![2]?.sessionId).toBeUndefined();
		},
	);

	it("requires and sanitizes one structured progress call", async () => {
		const caller = { complete: vi.fn<Complete>().mockResolvedValue(summaryCall({ blockers: "None\u0000" })) };
		const result = await observe({
			caller,
			model,
			prompt: "evidence",
			config: DEFAULT_CONFIG,
		});
		expect(result).toEqual({
			kind: "success",
			summary: {
				goal: "Ship observer",
				progress: "Config is complete",
				current: "Writing tests",
				next: "Run checks",
				blockers: "None",
			},
		});
		const context = caller.complete.mock.calls[0]![1];
		expect(context.tools?.[0]?.name).toBe("submit_progress");
		expect(context.systemPrompt).toContain("Do not claim access to hidden reasoning");
		expect(context.systemPrompt).toContain("never state what did not happen");
		expect(context.systemPrompt).toContain("Never hedge");
	});

	it("omits next instead of forcing an invented step", async () => {
		const response = summaryCall();
		delete response.content[0]!.arguments.next;
		const result = await observe({
			caller: { complete: vi.fn<Complete>().mockResolvedValue(response) },
			model,
			prompt: "record",
			config: DEFAULT_CONFIG,
		});
		expect(result).toEqual({
			kind: "success",
			summary: { goal: "Ship observer", progress: "Config is complete", current: "Writing tests" },
		});
		expect(result.kind === "success" && "next" in result.summary).toBe(false);
	});

	it("still requires goal, progress, and current", async () => {
		const response = summaryCall();
		delete response.content[0]!.arguments.current;
		const result = await observe({
			caller: { complete: vi.fn<Complete>().mockResolvedValue(response) },
			model,
			prompt: "record",
			config: DEFAULT_CONFIG,
		});
		expect(result).toMatchObject({ kind: "error", cause: "malformed" });
	});

	it("does not dispatch an already cancelled observation", async () => {
		const complete = vi.fn<Complete>().mockResolvedValue(summaryCall());
		const controller = new AbortController();
		controller.abort();
		await expect(
			observe({
				caller: { complete },
				model,
				prompt: "record",
				config: DEFAULT_CONFIG,
				signal: controller.signal,
			}),
		).resolves.toEqual({ kind: "cancelled" });
		expect(complete).not.toHaveBeenCalled();
	});

	it("times out a provider that ignores abort and handles its late rejection", async () => {
		vi.useFakeTimers();
		let rejectProvider!: (error: Error) => void;
		const complete = vi.fn<Complete>(
			() =>
				new Promise((_resolve, reject) => {
					rejectProvider = reject;
				}),
		);
		const settled = vi.fn();
		const pending = observe({ caller: { complete }, model, prompt: "record", config: DEFAULT_CONFIG }).then(
			settled,
		);
		await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.timeoutMs);
		expect(settled).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", cause: "timeout" }));
		expect(complete.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
		expect(complete).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		rejectProvider(new Error("late provider failure"));
		await pending;
	});

	it("settles cancellation without waiting for a late summary", async () => {
		let resolveProvider!: (response: AssistantMessage) => void;
		const complete = vi.fn<Complete>(
			() =>
				new Promise((resolve) => {
					resolveProvider = resolve;
				}),
		);
		const controller = new AbortController();
		const settled = vi.fn();
		const pending = observe({
			caller: { complete },
			model,
			prompt: "record",
			config: DEFAULT_CONFIG,
			signal: controller.signal,
		}).then(settled);
		controller.abort();
		await vi.waitFor(() => expect(settled).toHaveBeenCalledWith({ kind: "cancelled" }));
		resolveProvider(summaryCall());
		await pending;
		expect(settled).toHaveBeenCalledOnce();
	});

	it("reports malformed responses without inventing a summary", async () => {
		const result = await observe({
			caller: { complete: vi.fn<Complete>().mockResolvedValue({ ...summaryCall(), content: [] }) },
			model,
			prompt: "evidence",
			config: DEFAULT_CONFIG,
		});
		expect(result).toMatchObject({ kind: "error", cause: "malformed" });
	});
});
