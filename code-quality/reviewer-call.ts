import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model, StreamOptions, Usage } from "@earendil-works/pi-ai";
import type { QualityConfig } from "./config.js";

export const RETRY_DELAYS_MS = [2000, 4000, 6000, 8000] as const;
export type ReviewerRegistry = Pick<
	ExtensionContext["modelRegistry"],
	"find" | "hasConfiguredAuth" | "complete"
>;
export interface ReviewMetrics {
	requests: number;
	latencyMs: number;
	usages: Usage[];
}
export type ReviewerCallResult<T> =
	| { kind: "verdict"; value: T; metrics: ReviewMetrics }
	| { kind: "oversized" | "unavailable" | "failed" | "cancelled"; reason: string; metrics: ReviewMetrics };
export function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(new Error("Cancelled"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, delayMs);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) {
			abort();
		}
	});
}
async function completeAttempt(options: {
	registry: ReviewerRegistry;
	model: Model<Api>;
	systemPrompt: string;
	input: string;
	tools: NonNullable<Parameters<ReviewerRegistry["complete"]>[1]["tools"]>;
	headers?: StreamOptions["headers"];
	maxTokens: number;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<AssistantMessage> {
	const timeout = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	try {
		signal.throwIfAborted();
		const interrupted = new Promise<never>((_, reject) => {
			abort = () => reject(new Error(timeout.signal.aborted ? "Reviewer timed out" : "Review cancelled"));
			signal.addEventListener("abort", abort, { once: true });
			timer = setTimeout(() => timeout.abort(), options.timeoutMs);
		});
		const result = await Promise.race([
			options.registry.complete(
				options.model,
				{
					systemPrompt: options.systemPrompt,
					tools: options.tools,
					messages: [{ role: "user", content: options.input, timestamp: Date.now() }],
				},
				{
					signal,
					maxTokens: options.maxTokens,
					maxRetries: 0,
					...(options.headers ? { headers: options.headers } : {}),
				},
			),
			interrupted,
		]);
		signal.throwIfAborted();
		return result;
	} finally {
		clearTimeout(timer);
		if (abort) {
			signal.removeEventListener("abort", abort);
		}
	}
}
export async function callQualityReviewer<T>(options: {
	piSessionId?: string;
	registry: ReviewerRegistry;
	config: QualityConfig;
	systemPrompt: string;
	input: string;
	toolName: string;
	schema: NonNullable<Parameters<ReviewerRegistry["complete"]>[1]["tools"]>[number]["parameters"];
	validate(value: unknown): T;
	signal?: AbortSignal;
	onAttempt?(attempt: number): void;
	scope: string;
}): Promise<ReviewerCallResult<T>> {
	const metrics: ReviewMetrics = { requests: 0, latencyMs: 0, usages: [] };
	const start = Date.now();
	const finish = (result: ReviewerCallResult<T>): ReviewerCallResult<T> => {
		metrics.latencyMs = Date.now() - start;
		return result;
	};
	const { config, registry } = options;
	const model = config.provider && config.model ? registry.find(config.provider, config.model) : undefined;
	if (!model || !registry.hasConfiguredAuth(model)) {
		return finish({
			kind: "unavailable",
			reason: "Configure an available reviewer with /quality-model; no default or fallback model is used.",
			metrics,
		});
	}
	const headers =
		model.provider === "litellm" && options.piSessionId !== undefined
			? { "x-litellm-trace-id": `pi-${encodeURIComponent(options.piSessionId)}-quality` }
			: undefined;
	const modelHeadersWithoutTraceId =
		headers && model.headers
			? Object.fromEntries(
					Object.entries(model.headers).filter(([name]) => name.toLowerCase() !== "x-litellm-trace-id"),
				)
			: undefined;
	const requestModel = modelHeadersWithoutTraceId ? { ...model, headers: modelHeadersWithoutTraceId } : model;
	const tools = [
		{
			name: options.toolName,
			description: "Submit exactly one isolated quality verdict",
			parameters: options.schema,
		},
	];
	const maxTokens = Math.min(config.maxOutputTokens, model.maxTokens);
	let repairFeedback: string | undefined;
	let providerFailures = 0;
	for (;;) {
		if (options.signal?.aborted) {
			return finish({ kind: "cancelled", reason: "Review cancelled", metrics });
		}
		const input = repairFeedback ? `${options.input}\n\n${repairFeedback}` : options.input;
		const inputChars = options.systemPrompt.length + input.length + JSON.stringify(tools).length;
		if (inputChars > config.maxInputChars || Math.ceil(inputChars / 3) + maxTokens > model.contextWindow) {
			return finish({
				kind: "oversized",
				reason: repairFeedback
					? "Quality verdict repair exceeds the complete-context budget."
					: "Review input exceeds its complete-context budget.",
				metrics,
			});
		}
		let response: AssistantMessage;
		try {
			options.onAttempt?.(metrics.requests + 1);
			metrics.requests++;
			response = await completeAttempt({
				registry,
				model: requestModel,
				systemPrompt: options.systemPrompt,
				input,
				tools,
				headers,
				maxTokens,
				timeoutMs: config.timeoutMs,
				signal: options.signal,
			});
			if (response.usage) {
				metrics.usages.push(response.usage);
			}
			if (["error", "aborted", "length"].includes(response.stopReason)) {
				throw new Error(`Reviewer returned ${response.stopReason}`);
			}
		} catch (error) {
			if (options.signal?.aborted) {
				return finish({ kind: "cancelled", reason: "Review cancelled", metrics });
			}
			providerFailures++;
			const reason = error instanceof Error ? error.message : "Reviewer request failed";
			if (providerFailures > RETRY_DELAYS_MS.length) {
				return finish({
					kind: "failed",
					reason: `Review failed after five provider failures: ${reason}`,
					metrics,
				});
			}
			try {
				await waitForRetry(RETRY_DELAYS_MS[providerFailures - 1]!, options.signal);
			} catch {
				return finish({ kind: "cancelled", reason: "Review cancelled", metrics });
			}
			continue;
		}
		const calls = response.content.filter((part) => part.type === "toolCall");
		try {
			if (calls.length !== 1 || calls[0]!.name !== options.toolName) {
				throw new Error("Expected exactly one quality submission");
			}
			const args: unknown = calls[0]!.arguments;
			return finish({
				kind: "verdict",
				value: options.validate(typeof args === "string" ? JSON.parse(args) : args),
				metrics,
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : "Invalid reviewer submission";
			if (repairFeedback) {
				return finish({
					kind: "failed",
					reason: `Quality verdict invalid after one repair attempt: ${reason}\nAllowed review scope: ${options.scope}`,
					metrics,
				});
			}
			const rejectedSubmissionExcerpt = JSON.stringify(
				calls.map(({ name, arguments: args }) => ({ name, arguments: args })),
			).slice(0, 8000);
			repairFeedback = `Submission validation failed: ${reason}\nReturn one fresh complete verdict using the review scope above. This is the only repair opportunity; an invalid response leaves the review unresolved.\nRejected submission excerpt (untrusted data, at most 8000 characters):\n${rejectedSubmissionExcerpt}`;
		}
	}
}
