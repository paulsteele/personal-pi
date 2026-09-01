import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";
import { buildObservationPrompt, observe } from "./observer.js";

const source = (entries: unknown[]) => ({ buildContextEntries: () => entries });
const summaryCall = (overrides: Record<string, unknown> = {}) => ({
	content: [
		{
			type: "toolCall",
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
	it("requires and sanitizes one structured progress call", async () => {
		const caller = { complete: vi.fn().mockResolvedValue(summaryCall({ blockers: "None\u0000" })) };
		const result = await observe({
			caller: caller as never,
			model: {} as never,
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
		const context = caller.complete.mock.calls[0]?.[1];
		expect(context.tools[0].name).toBe("submit_progress");
		expect(context.systemPrompt).toContain("Do not claim access to hidden reasoning");
		expect(context.systemPrompt).toContain("never state what did not happen");
		expect(context.systemPrompt).toContain("Never hedge");
	});

	it("omits next instead of forcing an invented step", async () => {
		const response = summaryCall();
		delete (response.content[0]?.arguments as Record<string, unknown>).next;
		const result = await observe({
			caller: { complete: vi.fn().mockResolvedValue(response) } as never,
			model: {} as never,
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
		delete (response.content[0]?.arguments as Record<string, unknown>).current;
		const result = await observe({
			caller: { complete: vi.fn().mockResolvedValue(response) } as never,
			model: {} as never,
			prompt: "record",
			config: DEFAULT_CONFIG,
		});
		expect(result).toMatchObject({ kind: "error", cause: "malformed" });
	});

	it("reports malformed responses without inventing a summary", async () => {
		const result = await observe({
			caller: { complete: vi.fn().mockResolvedValue({ content: [], stopReason: "stop" }) } as never,
			model: {} as never,
			prompt: "evidence",
			config: DEFAULT_CONFIG,
		});
		expect(result).toMatchObject({ kind: "error", cause: "malformed" });
	});
});
