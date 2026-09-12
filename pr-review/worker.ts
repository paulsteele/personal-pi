import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Model,
	type Api,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { validate, type Config } from "./types.js";

export type Registry = Pick<
	ExtensionContext["modelRegistry"],
	"find" | "getProvider" | "getApiKeyAndHeaders" | "hasConfiguredAuth"
>;
export interface WorkerUsage {
	input: number;
	output: number;
	cost: number;
}
export type WorkerResult<T> =
	| { ok: true; value: T; usage: WorkerUsage }
	| { ok: false; error: string; usage: WorkerUsage };
function failure(model: Model<Api>, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		model: model.id,
		provider: model.provider,
		timestamp: Date.now(),
		content: [],
		stopReason: aborted ? "aborted" : "error",
		errorMessage: aborted ? "Worker cancelled" : "Review provider request failed",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
/** Public registry bridge; deliberately does not copy the main session's context or extensions. */
export function registryStream(registry: Registry, config: Config): StreamFn {
	return (model, context, options) => {
		const output = createAssistantMessageEventStream();
		let closed = false;
		const fail = () => {
			if (closed) return;
			closed = true;
			const error = failure(model, Boolean(options?.signal?.aborted));
			output.push({ type: "error", reason: error.stopReason === "aborted" ? "aborted" : "error", error });
		};
		options?.signal?.addEventListener("abort", fail, { once: true });
		void (async () => {
			try {
				if (options?.signal?.aborted) return fail();
				if (Buffer.byteLength(JSON.stringify(context)) > config.maxInputBytes * 3) return fail();
				const auth = await registry.getApiKeyAndHeaders(model);
				if (closed || options?.signal?.aborted) return fail();
				const provider = registry.getProvider(model.provider);
				if (!auth.ok || !provider) return fail();
				const effectiveModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
				const stream = provider.streamSimple(effectiveModel, context, {
					...options,
					...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
					headers: { ...auth.headers, ...options?.headers },
					env: { ...auth.env, ...options?.env },
					timeoutMs: config.timeoutMs,
					maxRetries: 1,
					maxRetryDelayMs: Math.min(config.timeoutMs, 10000),
				});
				for await (const event of stream) {
					if (closed) break;
					output.push(event);
					if (event.type === "done" || event.type === "error") closed = true;
				}
				if (!closed) fail();
			} catch {
				fail();
			} finally {
				options?.signal?.removeEventListener("abort", fail);
			}
		})();
		return output;
	};
}
export async function runWorker<T extends TSchema>(options: {
	registry: Registry;
	config: Config;
	schema: T;
	system: string;
	input: unknown;
	tools?: AgentTool[];
	signal?: AbortSignal;
	progress?: (text: string) => void;
}): Promise<WorkerResult<Static<T>>> {
	const usage: WorkerUsage = { input: 0, output: 0, cost: 0 };
	const model = options.registry.find(options.config.provider, options.config.model);
	if (!model || !options.registry.hasConfiguredAuth(model))
		return { ok: false, error: "Independent review model unavailable; use /pr model", usage };
	const prompt = JSON.stringify(options.input);
	if (Buffer.byteLength(options.system + prompt) > options.config.maxInputBytes)
		return { ok: false, error: "Required context exceeds worker input budget", usage };
	let submitted = false;
	let invalidSubmission = false;
	let result: Static<T> | undefined;
	let turns = 0;
	let timedOut = false;
	const submit: AgentTool<T> = {
		name: "submit_result",
		label: "Submit result",
		description: "Submit the final structured result once. No further actions are allowed after submission.",
		parameters: options.schema,
		executionMode: "sequential",
		async execute(_id, args) {
			if (submitted) {
				invalidSubmission = true;
				throw new Error("Duplicate submission");
			}
			result = validate(options.schema, args);
			submitted = true;
			return { content: [{ type: "text", text: "Result accepted" }], details: {}, terminate: true };
		},
	};
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: options.system,
			thinkingLevel: model.reasoning ? options.config.thinking : "off",
			tools: [...(options.tools ?? []), submit as AgentTool],
		},
		streamFn: registryStream(options.registry, options.config),
		shouldStopAfterTurn: () => submitted || turns >= options.config.maxTurns,
		beforeToolCall: async () => {
			if (!submitted) return undefined;
			invalidSubmission = true;
			return { block: true, reason: "Worker already submitted", terminate: true };
		},
	});
	const unsubscribe = agent.subscribe((event) => {
		if (event.type === "turn_start") {
			turns++;
			options.progress?.(`turn ${turns}`);
		}
		if (event.type === "tool_execution_start") options.progress?.(event.toolName);
		if (event.type === "message_end" && event.message.role === "assistant") {
			usage.input += event.message.usage.input;
			usage.output += event.message.usage.output;
			usage.cost += event.message.usage.cost.total;
		}
	});
	const abort = () => agent.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		agent.abort();
	}, options.config.timeoutMs);
	try {
		if (options.signal?.aborted) return { ok: false, error: "Cancelled", usage };
		await agent.prompt(prompt);
		if (options.signal?.aborted || timedOut)
			return { ok: false, error: timedOut ? "Worker deadline exhausted" : "Cancelled", usage };
		if (!submitted || invalidSubmission || result === undefined || agent.state.errorMessage)
			return {
				ok: false,
				error: agent.state.errorMessage
					? "Worker/provider failed"
					: "Worker finished without a valid complete submission",
				usage,
			};
		return { ok: true, value: result, usage };
	} catch {
		return { ok: false, error: "Worker failed", usage };
	} finally {
		clearTimeout(timeout);
		unsubscribe();
		options.signal?.removeEventListener("abort", abort);
		agent.clearAllQueues();
	}
}
