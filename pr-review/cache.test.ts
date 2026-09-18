import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { runWorker, type Registry } from "./worker.js";
import { CoverageLedger } from "./tasks.js";
import { ReviewSubmission } from "./types.js";
import { testConfig } from "./test-fixtures.js";
import { emptyUsage, sumUsage, providerUsage, toProviderUsage, formatUsage, formatCost } from "./usage.js";
import { packInlineContext } from "./worker-context.js";

const measured: Usage = {
	input: 3,
	output: 5,
	cacheRead: 10000,
	cacheWrite: 1000,
	totalTokens: 11008,
	cost: { input: 0.00003, output: 0.00025, cacheRead: 0.01, cacheWrite: 0.0125, total: 0.02278 },
};
const submit = { name: "submit_result", args: { complete: true, limitations: [], findings: [] } };
type Action = { name: string; args: unknown };
function scripted(actions: Action[], window = 100000) {
	const calls: Array<{ context: Context; options: SimpleStreamOptions; summary: boolean }> = [];
	let at = 0;
	const model = {
		provider: "fake",
		id: "test",
		api: "openai-responses",
		reasoning: false,
		contextWindow: window,
		maxTokens: 1000,
	};
	const registry = {
		find: () => model,
		hasConfiguredAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true }),
		getProvider: () => ({
			streamSimple: (_model: unknown, context: Context, options: SimpleStreamOptions) => {
				const summary = !context.tools?.length;
				calls.push({ context: JSON.parse(JSON.stringify(context)), options, summary });
				const action = summary ? undefined : actions[at++];
				if (!summary && !action) throw new Error("Unexpected extra request");
				const message = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: 0,
					stopReason: summary ? "stop" : "toolUse",
					usage: structuredClone(measured),
					content: summary
						? [{ type: "text", text: "Continue; source remains available." }]
						: [{ type: "toolCall", id: `call-${at}`, name: action!.name, arguments: action!.args }],
				} as AssistantMessage;
				const stream = createAssistantMessageEventStream();
				if (action?.name === "$error")
					stream.push({
						type: "error",
						reason: "error",
						error: { ...message, content: [], stopReason: "error", errorMessage: "Network error" },
					});
				else stream.push({ type: "done", reason: summary ? "stop" : "toolUse", message });
				return stream;
			},
		}),
	} as unknown as Registry;
	return { registry, calls };
}
async function* resources(entries: Array<[string, string]>) {
	for (const [id, text] of entries) yield { id, text, total: text.length };
}
it("shares documentation prefixes while placing distinct lenses before any inline diff", async () => {
	const prompts: string[] = [],
		ids: string[] = [];
	for (const lens of ["security", "correctness"]) {
		const script = scripted([submit]);
		const coverage = new CoverageLedger(["doc:rules.md", "diff:a.ts"]);
		const result = await runWorker({
			registry: script.registry,
			config: testConfig,
			schema: ReviewSubmission,
			system: "Shared review policy",
			input: {
				project: "Repository background",
				lens: { id: lens, focus: `Find ${lens} defects` },
				assignedFiles: ["a.ts"],
			},
			assignment: { id: lens, focus: `Find ${lens} defects` },
			coverage,
			sharedResources: resources([["doc:rules.md", "Shared guidance λ\n".repeat(300)]]),
			resources: resources([["diff:a.ts", "DIFF-MARKER"]]),
		});
		expect(result.ok).toBe(true);
		expect(coverage.remaining).toEqual([]);
		expect(toProviderUsage(result.usage)).toEqual(measured);
		expect(result.usage.byRequest?.first.requests).toBe(1);
		const call = script.calls[0]!;
		expect(call.options.cacheRetention).toBeUndefined();
		ids.push(call.options.sessionId!);
		const text = (call.context.messages[0]!.content as Array<{ text: string }>)[0]!.text;
		expect(text.indexOf("Shared guidance")).toBeLessThan(text.indexOf('"lens"'));
		expect(text.indexOf(`Find ${lens} defects`)).toBeLessThan(text.indexOf("DIFF-MARKER"));
		expect(JSON.parse(text).sharedContext.map((r: { id: string }) => r.id)).toEqual(["doc:rules.md"]);
		prompts.push(text.slice(0, text.indexOf('"lens"')));
	}
	expect(prompts[0]).toBe(prompts[1]);
	expect(ids[0]).toBeTruthy();
	expect(ids[0]).not.toBe(ids[1]);
});
it("preserves routing and accounts for failed requests and continuations without changing retention", async () => {
	const script = scripted([{ name: "$error", args: {} }, submit]);
	const result = await runWorker({
		registry: script.registry,
		config: testConfig,
		schema: ReviewSubmission,
		system: "Policy",
		input: {},
		sessionId: "stable-task",
		recover: async () => {},
	});
	expect(result.ok).toBe(true);
	expect(script.calls.map((c) => c.options.sessionId)).toEqual(["stable-task", "stable-task"]);
	expect(script.calls.every((c) => c.options.cacheRetention === undefined)).toBe(true);
	expect(result.usage.cacheRead).toBe(measured.cacheRead * 2);
	expect(result.usage.byRequest?.first.requests).toBe(1);
	expect(result.usage.byRequest?.continuation.requests).toBe(1);
	expect(result.usage.cost).toBeCloseTo(measured.cost.total * 2);
});
it("keeps the lens before paged diffs, restores it after compaction, and isolates summary routing/usage", async () => {
	const lens = { id: "security", focus: "SECURITY-ASSIGNMENT" };
	const input = { project: "Fixture", lens, manifest: "m".repeat(65000) };
	const actions: Action[] = [{ name: "read_diff", args: {} }];
	for (let cursor = 0; cursor < JSON.stringify(input).length; cursor += 8000)
		actions.push({ name: "read_task_input", args: { cursor } });
	actions.push(submit);
	const script = scripted(actions, 14000);
	const result = await runWorker({
		registry: script.registry,
		config: testConfig,
		schema: ReviewSubmission,
		system: "Review the whole assignment",
		input,
		assignment: lens,
		sessionId: "paged-task",
		tools: [
			{
				name: "read_diff",
				label: "Diff",
				description: "Read a synthetic diff",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "DIFF-MARKER:" + "d".repeat(16000) }], details: {} };
				},
			},
		],
	});
	expect(result.ok).toBe(true);
	const ordinary = script.calls.filter((c) => !c.summary),
		summaries = script.calls.filter((c) => c.summary);
	expect(summaries.length).toBeGreaterThan(0);
	for (const call of ordinary) {
		expect(call.options.sessionId).toBe("paged-task");
		expect(call.options.cacheRetention).toBeUndefined();
		const serialized = JSON.stringify(call.context.messages);
		if (serialized.includes("DIFF-MARKER"))
			expect(serialized.indexOf("SECURITY-ASSIGNMENT")).toBeLessThan(serialized.indexOf("DIFF-MARKER"));
		expect(serialized).toContain("SECURITY-ASSIGNMENT");
	}
	for (const call of summaries) {
		expect(call.options.sessionId).toBeTruthy();
		expect(call.options.sessionId).not.toBe("paged-task");
		expect(call.options.cacheRetention).toBe("none");
	}
	expect(result.usage.byRequest?.compaction.requests).toBe(summaries.length);
	expect(result.usage.byRequest?.continuation.requests).toBe(ordinary.length - 1);
	expect(result.usage.cacheRead).toBe(script.calls.length * measured.cacheRead);
	expect(result.usage.totalTokens).toBe(script.calls.length * measured.totalTokens);
});
it("does not credit incomplete/oversized shared documents and counts escaped prefix bytes exactly", async () => {
	const packed = await packInlineContext(
		'{"project":"p","lens":"security"}',
		resources([["diff:a", "diff"]]),
		(n) => n < 2000,
		undefined,
		{
			resources: resources([
				["doc:large", "x".repeat(4000)],
				["doc:small", 'λ\\\n"'],
			]),
			fitsLength: (n) => n < 500,
		},
	);
	expect(packed.bytes).toBe(Buffer.byteLength(packed.text));
	expect(packed.delivered.map((r) => r.id)).toEqual(["doc:small", "diff:a"]);
	const ledger = new CoverageLedger(["doc:large", "doc:small", "diff:a"]);
	for (const r of packed.delivered) ledger.deliver(r.id, 0, r.total, r.total);
	expect(() => ledger.assertComplete()).toThrow("doc:large");
});
it("inlines shared-prefix overflow after the lens rather than forcing avoidable reads", async () => {
	const docs: Array<[string, string]> = [
		["doc:small", "guidance"],
		["doc:large", "x".repeat(500)],
	];
	const packed = await packInlineContext(
		'{"project":"p","lens":"security"}',
		resources([...docs, ["diff:a", "DIFF"]]),
		(n) => n < 2000,
		undefined,
		{ resources: resources(docs), fitsLength: (n) => n < 150 },
	);
	const input = JSON.parse(packed.text);
	expect(input.sharedContext.map((r: { id: string }) => r.id)).toEqual(["doc:small"]);
	expect(input.suppliedContext.map((r: { id: string }) => r.id)).toEqual(["doc:large", "diff:a"]);
	expect(packed.delivered.map((r) => r.id)).toEqual(["doc:small", "doc:large", "diff:a"]);
	expect(packed.text.indexOf('"lens"')).toBeLessThan(packed.text.indexOf("doc:large"));
});
it("reserves near-budget assignment space and retains smaller inline evidence", async () => {
	const assignment = { project: "p", lens: "security", manifest: "m".repeat(1700) };
	const docs: Array<[string, string]> = [["doc:large", "x".repeat(500)]];
	const packed = await packInlineContext(
		JSON.stringify(assignment),
		resources([...docs, ["diff:a", 'small diff λ\\\n"']]),
		(n) => n <= 2000,
		undefined,
		{ resources: resources(docs), fitsLength: (n) => n <= 600 },
	);
	expect(packed.text.length).toBeLessThanOrEqual(2000);
	expect(packed.bytes).toBe(Buffer.byteLength(packed.text));
	expect(JSON.parse(packed.text)).toEqual({
		...assignment,
		suppliedContext: [{ id: "diff:a", text: 'small diff λ\\\n"' }],
	});
	expect(packed.delivered).toEqual([{ id: "diff:a", total: 'small diff λ\\\n"'.length }]);
	const ledger = new CoverageLedger(["doc:large", "diff:a"]);
	for (const r of packed.delivered) ledger.deliver(r.id, 0, r.total, r.total);
	expect(ledger.remaining).toEqual(["doc:large"]);
});
it.each([{}, { project: "p" }, { project: 'p\\\n"', lens: "security", manifest: "λ".repeat(100) }])(
	"accounts for exact shared-prefix/assignment JSON framing: %j",
	async (input) => {
		const { project, ...assignment } = input as { project?: string; lens?: string; manifest?: string };
		const doc = { id: "doc:a", text: 'λ\\\n"' };
		const expected = JSON.stringify({
			...(project === undefined ? {} : { project }),
			sharedContext: [doc],
			...assignment,
		});
		for (const limit of [expected.length, expected.length - 1]) {
			const packed = await packInlineContext(
				JSON.stringify(input),
				resources([]),
				(n) => n <= limit,
				undefined,
				{ resources: resources([[doc.id, doc.text]]), fitsLength: () => true },
			);
			expect(packed.text.length).toBeLessThanOrEqual(limit);
			expect(packed.bytes).toBe(Buffer.byteLength(packed.text));
			expect(packed.text).toBe(limit === expected.length ? expected : JSON.stringify(input));
			expect(packed.delivered).toEqual(
				limit === expected.length ? [{ id: doc.id, total: doc.text.length }] : [],
			);
		}
	},
);
it("does not overflow an exactly full assignment with empty shared-context framing", async () => {
	const input = '{"project":"p","lens":"security"}';
	const packed = await packInlineContext(input, resources([]), (n) => n <= input.length, undefined, {
		resources: resources([["doc:large", "x".repeat(500)]]),
		fitsLength: () => true,
	});
	expect(packed.text).toBe(input);
	expect(packed.delivered).toEqual([]);
});
it("round-trips provider counters and costs, but never represents unknown legacy counters as zero", () => {
	const once = providerUsage(measured, "first");
	const twice = sumUsage(once, providerUsage(measured, "continuation"));
	expect(toProviderUsage(sumUsage(emptyUsage(), once))).toEqual(measured);
	expect(twice.costBreakdown?.cacheWrite).toBeCloseTo(0.025);
	expect(twice.byRequest?.first.cacheRead).toBe(10000);
	expect(twice.byRequest?.continuation.cacheRead).toBe(10000);
	const legacy = { input: 3, output: 5, cost: 0.2 };
	expect(toProviderUsage(legacy)).toBeUndefined();
	expect(formatUsage(legacy)).toContain("cache metrics unavailable");
	expect(formatUsage(sumUsage(once, legacy))).toContain("unknown total tokens");
	expect(formatCost(legacy)).toBe("Cost breakdown unavailable");
});
