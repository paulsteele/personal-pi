import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { runWorker, type Registry } from "./worker.js";
import { ReviewSubmission } from "./types.js";
import { testConfig } from "./test-fixtures.js";

export function fakeRegistry(values: unknown[], inspect?: (options: unknown) => void): Registry {
	let index = 0;
	const model = {
		provider: "fake",
		id: "test",
		api: "openai-responses",
		reasoning: false,
		contextWindow: 100000,
		maxTokens: 2000,
	};
	return {
		find: () => model,
		hasConfiguredAuth: () => true,
		getApiKeyAndHeaders: async () => ({
			ok: true,
			apiKey: "fixture-secret",
			baseUrl: "https://example.invalid",
			headers: { "x-test": "yes" },
			env: { TEST: "set" },
		}),
		getProvider: () => ({
			streamSimple: (_model: unknown, _context: unknown, options: unknown) => {
				inspect?.(options);
				const value = values[index++];
				const stream = createAssistantMessageEventStream();
				const message = {
					role: "assistant",
					api: "openai-responses",
					model: "test",
					provider: "fake",
					timestamp: Date.now(),
					content:
						value === undefined
							? [{ type: "text", text: "No submission" }]
							: [{ type: "toolCall", id: `s${index}`, name: "submit_result", arguments: value }],
					stopReason: value === undefined ? "stop" : "toolUse",
					usage: {
						input: 5,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 7,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				} as AssistantMessage;
				stream.push({ type: "done", reason: value === undefined ? "stop" : "toolUse", message });
				return stream;
			},
		}),
	} as unknown as Registry;
}
it("uses public provider/auth context and accepts exactly one structured result", async () => {
	const value = { complete: true, limitations: [], findings: [] };
	let auth: unknown;
	const result = await runWorker({
		registry: fakeRegistry([value], (options) => {
			auth = options;
		}),
		config: testConfig,
		schema: ReviewSubmission,
		system: "Fixed policy",
		input: { task: "fixture" },
	});
	expect(result).toMatchObject({ ok: true, value, usage: { input: 5, output: 2 } });
	expect(auth).toMatchObject({
		apiKey: "fixture-secret",
		headers: { "x-test": "yes" },
		env: { TEST: "set" },
	});
	expect(JSON.stringify(result)).not.toContain("fixture-secret");
});
it("does not mistake text or malformed submissions for no findings", async () => {
	for (const values of [[], [{ surprise: true }]]) {
		const result = await runWorker({
			registry: fakeRegistry(values),
			config: { ...testConfig, maxTurns: 2 },
			schema: ReviewSubmission,
			system: "Fixed",
			input: {},
		});
		expect(result.ok).toBe(false);
	}
});
it("cancels even while authentication is stalled", async () => {
	const registry = fakeRegistry([]);
	registry.getApiKeyAndHeaders = () => new Promise(() => {});
	const result = await runWorker({
		registry,
		config: { ...testConfig, timeoutMs: 20 },
		schema: ReviewSubmission,
		system: "Fixed",
		input: {},
	});
	expect(result).toMatchObject({ ok: false, error: "Worker deadline exhausted" });
});
it("rejects oversized fixed context before dispatch", async () => {
	const result = await runWorker({
		registry: fakeRegistry([]),
		config: { ...testConfig, maxInputBytes: 10 },
		schema: ReviewSubmission,
		system: "Too large fixed instructions",
		input: {},
	});
	expect(result).toMatchObject({ ok: false, error: "Required context exceeds worker input budget" });
});
