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
				changed: "Config is complete",
				current: "Writing tests",
				verification: "Config tests pass; integration tests not run",
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
		expect(prompt).toContain("tool result: bash completed (inspect output for outcome)");
		expect(prompt).toContain("[redacted]");
		expect(prompt).not.toContain("hidden plan");
		expect(prompt).not.toContain("private-image");
		expect(prompt).not.toContain("hunter2");
		expect(prompt.length).toBeLessThanOrEqual(24_000);
	});

	it("preserves user constraints outside the recent window and labels the actual delta", () => {
		const entries = [
			{
				id: "request",
				type: "message",
				message: { role: "user", content: "Add fixtures without changing public APIs" },
			},
			...Array.from({ length: 42 }, (_, index) => ({
				id: `step-${index}`,
				type: "message",
				message: { role: "assistant", content: `Inspecting fixture ${index}` },
			})),
			{ id: "new-result", type: "message", message: { role: "assistant", content: "Added resume fixture" } },
		];
		const prompt = buildObservationPrompt(source(entries), {
			entryId: "step-41",
			summary: { goal: "Add fixtures", current: "Inspecting fixtures" },
		});
		expect(prompt).toContain("Add fixtures without changing public APIs");
		expect(prompt).toContain("PREVIOUS REPORT (recheck claims; do not treat as proof)");
		expect(prompt).toContain("CONTEXT: assistant: Inspecting fixture 41");
		expect(prompt).toContain("NEW: assistant: Added resume fixture");
	});

	it("recovers original requests from the active branch after compaction", () => {
		const prompt = buildObservationPrompt(
			{
				buildContextEntries: () => [{ type: "compaction", summary: "Resume fixture implemented" }],
				getBranch: () => [
					{ type: "message", message: { role: "user", content: "Keep the wire format compatible" } },
				],
			},
			{ entryId: "compacted-away", summary: { goal: "Add fixtures", attention: "Tests failing" } },
		);
		expect(prompt).toContain("Keep the wire format compatible");
		expect(prompt).toContain("Resume fixture implemented");
		expect(prompt).toContain("Previous boundary unavailable: do not claim a change");
	});

	it("keeps every new record beyond the old 36-message window when the budget permits", () => {
		const entries = Array.from({ length: 50 }, (_, index) => ({
			id: `step-${index}`,
			type: "message",
			message: { role: "assistant", content: `Step ${index}` },
		}));
		const prompt = buildObservationPrompt(source(entries), {
			entryId: "step-0",
			summary: { goal: "Add fixtures" },
		});
		expect(prompt).toContain("NEW: assistant: Step 1\n");
		expect(prompt).toContain("NEW: assistant: Step 49");
	});

	it("retains command identity and the final result of long tool output", () => {
		const prompt = buildObservationPrompt(
			source([
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "check", name: "bash", arguments: { command: "bun run test" } },
						],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "bash",
						toolCallId: "check",
						content: [
							{
								type: "text",
								text: `Starting tests ${"detail ".repeat(500)} Tests: 18 passed; full suite not run`,
							},
						],
					},
				},
			]),
		);
		expect(prompt).toContain('tool call: bash {"command":"bun run test"}');
		expect(prompt).toContain("Tests: 18 passed; full suite not run");
		expect(prompt).toContain("[excerpt omitted]");
	});

	it("bounds large records without dropping pinned user constraints", () => {
		const prompt = buildObservationPrompt(
			source([
				{ type: "message", message: { role: "user", content: "Preserve public API" } },
				...Array.from({ length: 80 }, () => ({
					type: "message",
					message: { role: "assistant", content: "x".repeat(4000) },
				})),
			]),
		);
		expect(prompt).toContain("Preserve public API");
		expect(prompt).toContain("[Older records omitted");
		expect(prompt.length).toBeLessThanOrEqual(24_000);
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
			await observe({
				caller: { complete },
				model: { ...model, provider },
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

	it("requires and sanitizes a structured supervision brief", async () => {
		const caller = {
			complete: vi
				.fn<Complete>()
				.mockResolvedValue(summaryCall({ attention: "Integration checks pending\u0000" })),
		};
		const result = await observe({ caller, model, prompt: "record", config: DEFAULT_CONFIG });
		expect(result).toEqual({
			kind: "success",
			summary: {
				goal: "Ship observer",
				changed: "Config is complete",
				current: "Writing tests",
				verification: "Config tests pass; integration tests not run",
				next: "Run checks",
				attention: "Integration checks pending",
			},
		});
		const context = caller.complete.mock.calls[0]![1];
		expect(context.tools?.[0]?.name).toBe("submit_progress");
		expect(context.systemPrompt).toContain("Do not claim access to hidden reasoning");
		expect(context.systemPrompt).toContain("Explicit uncertainty and negative facts are useful");
		expect(context.systemPrompt).toContain("Missing context is not proof a check never ran");
		expect(context.systemPrompt).toContain("Never promote a plan");
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
			summary: {
				goal: "Ship observer",
				changed: "Config is complete",
				current: "Writing tests",
				verification: "Config tests pass; integration tests not run",
			},
		});
	});

	it("requires the user goal", async () => {
		const response = summaryCall();
		delete response.content[0]!.arguments.goal;
		const result = await observe({
			caller: { complete: vi.fn<Complete>().mockResolvedValue(response) },
			model,
			prompt: "record",
			config: DEFAULT_CONFIG,
		});
		expect(result).toMatchObject({ kind: "error", cause: "malformed" });
	});

	it("accepts a goal without inventing activity, changes, or checks", async () => {
		const response = summaryCall();
		response.content[0]!.arguments = { goal: "Investigate reload notifications" };
		const result = await observe({
			caller: { complete: vi.fn<Complete>().mockResolvedValue(response) },
			model,
			prompt: "record",
			config: DEFAULT_CONFIG,
		});
		expect(result).toEqual({ kind: "success", summary: { goal: "Investigate reload notifications" } });
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
			prompt: "record",
			config: DEFAULT_CONFIG,
		});
		expect(result).toMatchObject({ kind: "error", cause: "malformed" });
	});
});
