import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
} from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { runWorker, type Registry } from "./worker.js";
import { packInlineContext } from "./worker-context.js";
import { CoverageLedger } from "./tasks.js";
import { FindingSchema, ReviewSubmission, VerificationSubmission, validate } from "./types.js";
import { testConfig } from "./test-fixtures.js";

function scriptedRegistry(
	actions: Array<{ name: string; args: unknown }>,
	contextWindow = 100000,
	observe?: (context: Context, summary: boolean) => void,
): Registry {
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
			streamSimple: (_model: unknown, context: Context) => {
				const summary = !context.tools?.length;
				observe?.(context, summary);
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
				if (action?.name === "$overflow")
					stream.push({
						type: "error",
						reason: "error",
						error: {
							...message,
							content: [],
							stopReason: "error",
							errorMessage: "Context window exhausted",
						},
					});
				else stream.push({ type: "done", reason: summary ? "stop" : "toolUse", message });
				return stream;
			},
		}),
	} as unknown as Registry;
}

it("rejects completion until every task-input page is supplied, even after source coverage closes", async () => {
	const input = { lens: { focus: "Distinct baseline guidance" }, manifest: "m".repeat(60000) };
	const ledger = new CoverageLedger(["diff:a"]);
	const submit = { name: "submit_result", args: { complete: true, limitations: [], findings: [] } };
	const actions = [
		{ name: "read_change", args: {} },
		{ name: "read_task_input", args: { cursor: 0 } },
		submit,
	];
	for (let cursor = 16000; cursor < JSON.stringify(input).length; cursor += 8000)
		actions.push({ name: "read_task_input", args: { cursor } });
	actions.push(submit, { name: "read_task_input", args: { cursor: 8000 } }, submit);
	let rejected = 0,
		compactions = 0;
	const validated = vi.fn();
	const result = await runWorker({
		registry: scriptedRegistry(actions, 12000),
		config: testConfig,
		schema: ReviewSubmission,
		system: "Review the full assignment",
		input,
		coverage: ledger,
		validateResult: validated,
		tools: [
			{
				name: "read_change",
				label: "Read",
				description: "Fixture",
				parameters: Type.Object({}),
				async execute() {
					ledger.deliver("diff:a", 0, 4, 4);
					return { content: [{ type: "text", text: "diff" }], details: {} };
				},
			},
		],
		event: (event) => {
			if (event.type === "compacting") compactions++;
			if (event.type === "tool" && event.text === "submit_result failed") {
				expect(ledger.remaining).toEqual([]);
				rejected++;
			}
		},
	});
	expect(result.ok).toBe(true);
	expect(rejected).toBe(2);
	expect(compactions).toBeGreaterThan(0);
	expect(validated).toHaveBeenCalledTimes(1);
});

it.each([
	{ resourceId: "diff:a", overflow: false },
	{ resourceId: "candidate:F1", overflow: false },
	{ resourceId: "diff:a", overflow: true },
])(
	"retains exact unread $resourceId results across compaction (overflow=$overflow)",
	async ({ resourceId, overflow }) => {
		const page = "FINAL-RAW-EVIDENCE:" + "x".repeat(12000);
		const ledger = new CoverageLedger([resourceId]);
		const toolName = resourceId.startsWith("diff:") ? "read_change" : "read_candidate";
		let compactions = 0;
		const reviewerContexts: Context[] = [],
			summaryContexts: Context[] = [];
		const tools: AgentTool[] = [
			{
				name: "read_history",
				label: "History",
				description: "Previously consumed context",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "h".repeat(26000) }], details: {} };
				},
			},
			{
				name: toolName,
				label: "Read",
				description: "Final evidence page",
				parameters: Type.Object({}),
				async execute() {
					ledger.deliver(resourceId, 0, page.length, page.length);
					return { content: [{ type: "text", text: page }], details: {} };
				},
			},
		];
		const result = await runWorker({
			registry: scriptedRegistry(
				[
					{ name: "read_history", args: {} },
					{ name: toolName, args: {} },
					...(overflow ? [{ name: "$overflow", args: {} }] : []),
					{ name: "submit_result", args: { complete: true, limitations: [], findings: [] } },
				],
				12000,
				(context, summary) => {
					(summary ? summaryContexts : reviewerContexts).push(JSON.parse(JSON.stringify(context)));
				},
			),
			config: testConfig,
			schema: ReviewSubmission,
			system: "Independent lens-specific review",
			input: {},
			tools,
			coverage: ledger,
			event: (event) => {
				if (event.type === "compacting") compactions++;
			},
		});
		expect(result.ok).toBe(true);
		expect(compactions).toBe(overflow ? 2 : 1);
		const finalContext = reviewerContexts.at(-1)!;
		expect(JSON.stringify(finalContext)).toContain("Working context summary");
		expect(
			finalContext.messages.some(
				(message) =>
					message.role === "toolResult" &&
					message.content.some((block) => block.type === "text" && block.text === page),
			),
		).toBe(true);
		expect(
			finalContext.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((block) => block.type === "toolCall" && block.name === toolName),
			),
		).toBe(true);
		expect(JSON.stringify(summaryContexts)).not.toContain("FINAL-RAW-EVIDENCE:");
	},
);

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
