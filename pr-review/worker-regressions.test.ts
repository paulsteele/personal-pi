import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { runWorker, type Registry } from "./worker.js";
import { packInlineContext } from "./worker-context.js";
import { CoverageLedger } from "./tasks.js";
import { FindingSchema, ReviewSubmission, VerificationSubmission, validate } from "./types.js";
import { testConfig } from "./test-fixtures.js";

function scriptedRegistry(actions: Array<{ name: string; args: unknown }>, contextWindow = 100000): Registry {
	let next = 0;
	const model = {
		provider: "fake",
		id: "test",
		api: "openai-responses",
		reasoning: false,
		contextWindow,
		maxTokens: 1000,
	};
	return {
		find: () => model,
		hasConfiguredAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true }),
		getProvider: () => ({
			streamSimple: (_model: unknown, context: { tools?: unknown[] }) => {
				const summary = !context.tools?.length;
				const action = summary ? undefined : actions[next++];
				if (!summary && !action) throw new Error("Script exhausted before worker completed");
				const message = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					stopReason: summary ? "stop" : "toolUse",
					content: summary
						? [{ type: "text", text: "Continue the same task; previous delivered context is summarized." }]
						: [{ type: "toolCall", id: `call-${next}`, name: action!.name, arguments: action!.args }],
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
}

it.each([false, true])(
	"requires all pages of an oversized candidate, even with paged metadata input (%s)",
	async (pagedInput) => {
		const finding = validate(FindingSchema, {
			title: "Candidate",
			severity: "medium",
			file: "a.ts",
			side: "new",
			startLine: 1,
			endLine: 1,
			problem: "p".repeat(4000),
			suggestion: "s".repeat(8000),
			rationale: "r".repeat(4000),
			evidence: Array.from({ length: 8 }, () => ({
				file: "a.ts",
				side: "new",
				line: 1,
				quote: "q".repeat(4000),
			})),
		});
		const text = JSON.stringify({ ...finding, id: "F1", reviewer: "Security" });
		const input = {
			candidateIds: ["F1"],
			candidates: [],
			...(pagedInput ? { metadata: "m".repeat(60000) } : {}),
		};
		const ledger = new CoverageLedger(["candidate:F1"]);
		const verdict = (kind: string) => ({
			name: "submit_result",
			args: { verdicts: [{ id: "F1", verdict: kind, reason: "Fixture" }] },
		});
		const actions: Array<{ name: string; args: unknown }> = [];
		if (pagedInput)
			for (let cursor = 0; cursor < JSON.stringify(input).length; cursor += 8000)
				actions.push({ name: "read_task_input", args: { cursor } });
		actions.push(verdict("confirmed"), { name: "read_candidate", args: { cursor: 0 } }, verdict("dropped"));
		for (let cursor = 8000; cursor < text.length; cursor += 8000)
			actions.push({ name: "read_candidate", args: { cursor } });
		actions.push(verdict("confirmed"));
		const tool: AgentTool = {
			name: "read_candidate",
			label: "Read",
			description: "Candidate pages",
			parameters: Type.Object({ cursor: Type.Integer({ minimum: 0 }) }),
			async execute(_id, args) {
				const cursor = (args as { cursor: number }).cursor,
					page = text.slice(cursor, cursor + 8000);
				ledger.deliver("candidate:F1", cursor, cursor + page.length, text.length);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								text: page,
								nextOffset: cursor + page.length < text.length ? cursor + page.length : null,
							}),
						},
					],
					details: {},
				};
			},
		};
		let rejected = 0;
		const result = await runWorker({
			registry: scriptedRegistry(actions, 12000),
			config: testConfig,
			schema: VerificationSubmission,
			system: "Verify the supplied candidate",
			input,
			tools: [tool],
			coverage: ledger,
			resources: (async function* () {
				yield { id: "candidate:F1", text, total: text.length };
			})(),
			event: (event) => {
				if (event.type === "tool" && event.text === "submit_result failed") rejected++;
			},
		});
		expect(result.ok).toBe(true);
		expect(rejected).toBe(2);
		expect(ledger.remaining).toEqual([]);
	},
);

it.each(["record_groups", "search_source"])(
	"does not mistake distinct successful %s calls for a stall",
	async (name) => {
		const actions = Array.from({ length: 5 }, (_, i) => ({ name, args: { value: `${i}` } }));
		const tool: AgentTool = {
			name,
			label: name,
			description: "Fixture",
			parameters: Type.Object({ value: Type.String() }),
			async execute() {
				return { content: [{ type: "text", text: "identical successful result" }], details: {} };
			},
		};
		const result = await runWorker({
			registry: scriptedRegistry([
				...actions,
				{ name: "submit_result", args: { complete: true, limitations: [], findings: [] } },
			]),
			config: testConfig,
			schema: ReviewSubmission,
			system: "Fixture",
			input: {},
			tools: [tool],
		});
		expect(result.ok).toBe(true);
	},
);

it("still detects repeated identical calls rather than counting idempotent replay as progress", async () => {
	const tool: AgentTool = {
		name: "record_groups",
		label: "Groups",
		description: "Fixture",
		parameters: Type.Object({ key: Type.String() }),
		async execute() {
			return { content: [{ type: "text", text: "same group already accepted" }], details: {} };
		},
	};
	const result = await runWorker({
		registry: scriptedRegistry(
			Array.from({ length: 5 }, () => ({ name: "record_groups", args: { key: "same" } })),
		),
		config: testConfig,
		schema: ReviewSubmission,
		system: "Fixture",
		input: {},
		tools: [tool],
	});
	expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Repeated identical") });
});

it("serializes each resource once after saturation and accounts for escaped UTF-8", async () => {
	const input = JSON.stringify({ project: 'λ\\\n"' });
	let reads = 0;
	const resources = (async function* () {
		for (let i = 0; i < 2000; i++)
			yield {
				id: `R${i}`,
				get text() {
					reads++;
					return 'λ\\\n"'.repeat(20);
				},
				total: 100,
			};
	})();
	// Construct total from the exact text; incomplete resources are never credited.
	const value = 'λ\\\n"'.repeat(20);
	const fixed = (async function* () {
		for await (const resource of resources)
			yield { id: resource.id, text: resource.text, total: value.length };
	})();
	const packed = await packInlineContext(input, fixed, (chars) => chars <= 1200);
	expect(reads).toBe(2000);
	expect(packed.bytes).toBe(Buffer.byteLength(packed.text));
	expect(packed.text.length).toBeLessThanOrEqual(1200);
	expect(JSON.parse(packed.text).suppliedContext).toHaveLength(packed.delivered.length);
	expect(packed.delivered.length).toBeGreaterThan(0);
	expect(packed.delivered.length).toBeLessThan(2000);
});
