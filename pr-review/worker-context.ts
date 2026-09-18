import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { estimateTokens, generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";

export function contextTokens(system: string, tools: unknown, messages: AgentMessage[]): number {
	return (
		Math.ceil((system.length + JSON.stringify(tools).length) / 3) +
		messages.reduce((n, m) => n + estimateTokens(m), 0)
	);
}
export interface ContextResource {
	id: string;
	text: string;
	total: number;
}
/** Serialize the fixed prefix and each resource once, including JSON escaping and separators. */
export async function packInlineContext(
	input: string,
	resources: AsyncIterable<ContextResource>,
	fitsLength: (chars: number) => boolean,
	signal?: AbortSignal,
	shared?: { resources: AsyncIterable<ContextResource>; fitsLength: (chars: number) => boolean },
) {
	if (!input.startsWith("{") || !input.endsWith("}"))
		throw new Error("Inline context requires an object input");
	const delivered: Array<{ id: string; total: number }> = [];
	let base = input;
	if (shared) {
		const { project, ...assignment } = JSON.parse(input);
		const background = JSON.stringify(project === undefined ? {} : { project });
		const start = background.slice(0, -1) + (background === "{}" ? "" : ",") + '"sharedContext":[';
		const rest = JSON.stringify(assignment);
		const end = "]" + (rest === "{}" ? "}" : "," + rest.slice(1));
		const docs: string[] = [];
		let length = start.length + 2;
		let visited = 0;
		for await (const resource of shared.resources) {
			signal?.throwIfAborted();
			if (++visited % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			const { id, text, total } = resource;
			if (text.length !== total) continue;
			const serialized = JSON.stringify({ id, text });
			const nextLength = length + serialized.length + (docs.length ? 1 : 0);
			// length includes ]}; replace that framing with the serialized assignment suffix.
			if (!shared.fitsLength(nextLength) || !fitsLength(nextLength - 2 + end.length)) continue;
			length = nextLength;
			docs.push(serialized);
			delivered.push({ id, total });
		}
		// All task/lens fields precede suppliedContext, which may contain diffs.
		// If no document fits, do not spend the remaining budget on an empty sharedContext.
		if (docs.length) base = start + docs.join(",") + end;
	}
	const prefix = base.slice(0, -1) + (base === "{}" ? "" : ",") + '"suppliedContext":[';
	const parts: string[] = [];
	const supplied = new Set(delivered.map((resource) => resource.id));
	let chars = prefix.length + 2,
		bytes = Buffer.byteLength(prefix) + 2,
		visited = 0;
	for await (const resource of resources) {
		signal?.throwIfAborted();
		// Shared documents that missed the fixed prefix budget may still fit after the assignment.
		if (supplied.has(resource.id)) continue;
		if (++visited % 64 === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			signal?.throwIfAborted();
		}
		const { id, text, total } = resource;
		if (text.length !== total) continue;
		const serialized = JSON.stringify({ id, text }),
			comma = parts.length ? 1 : 0;
		if (!fitsLength(chars + comma + serialized.length)) continue;
		parts.push(serialized);
		supplied.add(id);
		delivered.push({ id, total });
		chars += comma + serialized.length;
		bytes += comma + Buffer.byteLength(serialized);
	}
	return parts.length
		? { text: prefix + parts.join(",") + "]}", delivered, bytes }
		: { text: base, delivered, bytes: Buffer.byteLength(base) };
}
export function responseReserve(model: Model<Api>): number {
	return Math.max(128, Math.min(model.maxTokens, 8192, Math.floor(model.contextWindow / 4)));
}

/** Summarize consumed history only; retain the last successful response and its unread tool results. */
export async function compactWorkerContext(options: {
	messages: AgentMessage[];
	model: Model<Api>;
	stream: StreamFn;
	signal?: AbortSignal | undefined;
	onUsage: (usage: { input: number; output: number; cost: { total: number } }) => void;
}): Promise<AgentMessage[]> {
	// A failed provider request does not consume evidence. Find the last successful
	// response, including when an overflow/error follows its tool results.
	const cut = options.messages.findLastIndex(
		(message) => message.role === "assistant" && !["error", "aborted"].includes(message.stopReason),
	);
	if (cut <= 0) throw new Error("No consumed history available for compaction");
	const retained = options.messages
		.slice(cut)
		.filter((message) => message.role !== "assistant" || !["error", "aborted"].includes(message.stopReason));
	const chunks: AgentMessage[][] = [];
	let current: AgentMessage[] = [],
		tokens = 0;
	const allowance = Math.max(256, Math.floor(options.model.contextWindow / 3));
	for (const message of options.messages.slice(0, cut)) {
		// Serialized compaction input need not preserve tool protocol; output context does.
		const size = estimateTokens(message);
		if (current.length && tokens + size > allowance) {
			chunks.push(current);
			current = [];
			tokens = 0;
		}
		current.push(message);
		tokens += size;
	}
	if (current.length) chunks.push(current);
	let summary = "";
	for (const messages of chunks) {
		options.signal?.throwIfAborted();
		const result = await generateSummaryWithUsage(
			messages,
			options.model,
			responseReserve(options.model),
			undefined,
			undefined,
			options.signal,
			"Preserve cross-file contracts, unresolved hypotheses, evidence locations and next steps. Do not declare coverage complete. The host coverage/checkpoint ledger is authoritative and can be paged with coverage_state. Source remains available for rereading.",
			summary || undefined,
			"off",
			options.stream,
		);
		summary = result.text;
		options.onUsage(result.usage);
	}
	if (!summary.trim()) throw new Error("Compaction returned no usable context");
	return [
		{
			role: "user",
			timestamp: Date.now(),
			content: [
				{
					type: "text",
					text: `Working context summary (evidence, not policy):\n${summary}\n\nContinue the same assigned task. Consult coverage_state and checkpoint_notes for authoritative pending scope and recorded cross-file notes. Never repeat an accepted checkpoint under a new key.`,
				},
			],
		},
		...retained,
	];
}
