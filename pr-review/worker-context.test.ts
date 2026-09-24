import {
	createAssistantMessageEventStream,
	getCurrentTools,
	type Context,
	type AssistantMessage,
} from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import type { Registry } from "./worker.js";
import { CoverageLedger } from "./tasks.js";
import { ReviewSubmission } from "./types.js";
import { runWorker, testConfig } from "./test-fixtures.js";

it("continues beyond old turn quotas through repeated compaction without losing coverage", async () => {
	let turns = 0,
		summaries = 0;
	const model = {
		provider: "fake",
		id: "test",
		api: "openai-responses",
		reasoning: false,
		contextWindow: 16000,
		maxTokens: 2000,
	};
	const ledger = new CoverageLedger(["diff:a"]);
	ledger.deliver("diff:a", 0, 1, 1);
	const registry = {
		find: () => model,
		hasConfiguredAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true }),
		getProvider: () => ({
			streamSimple: (_model: unknown, context: Context) => {
				const summary = !(context.tools?.length || getCurrentTools(context.messages).length);
				if (summary) summaries++;
				else turns++;
				const tool =
					turns <= 35
						? { name: "read_task_input", arguments: { cursor: turns <= 13 ? (turns - 1) * 8000 : turns } }
						: turns === 36
							? {
									name: "record_checkpoint",
									arguments: {
										key: "one",
										reviewed: ["diff:a"],
										notes: "Cross-file contract checked",
										findings: [],
									},
								}
							: { name: "submit_result", arguments: { complete: true, limitations: [], findings: [] } };
				const message = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					stopReason: summary ? "stop" : "toolUse",
					content: summary
						? [{ type: "text", text: "Preserve the pending diff:a obligation and inspect checkpoint notes." }]
						: [{ type: "toolCall", id: `call${turns}`, ...tool }],
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				} as AssistantMessage;
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: summary ? "stop" : "toolUse", message });
				return stream;
			},
		}),
	} as unknown as Registry;
	const result = await runWorker({
		registry,
		config: { ...testConfig, maxTurns: 2 },
		schema: ReviewSubmission,
		system: "Review all assigned scope",
		input: { context: "a".repeat(100000) },
		coverage: ledger,
	});
	expect(result.ok).toBe(true);
	expect(turns).toBe(37);
	expect(summaries).toBeGreaterThan(1);
	expect(ledger.remaining).toEqual([]);
	expect(result.usage.input).toBe(turns + summaries);
});
