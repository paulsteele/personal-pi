import { randomUUID } from "node:crypto";
import { emptyUsage, sumUsage, providerUsage, type UsageTotals, type RequestKind } from "./usage.js";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Model,
	type Api,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { CheckpointSchema, validate, type Config, type Checkpoint } from "./types.js";
import { normalizeConfig } from "./config.js";
import { redact } from "./report.js";
import { CoverageLedger } from "./tasks.js";
import { commitToolResult, deferToolCommit } from "./tool-commit.js";
import { compactWorkerContext, contextTokens, packInlineContext, responseReserve } from "./worker-context.js";
import {
	PermissionBlocked,
	isPermissionBlocked,
	type PermissionScope,
	type SourceEffect,
	type PermissionWait,
} from "./permissions.js";

export type Registry = Pick<
	ExtensionContext["modelRegistry"],
	"find" | "getProvider" | "getApiKeyAndHeaders" | "hasConfiguredAuth"
>;
export type WorkerUsage = UsageTotals;
export type WorkerEvent = {
	type: "turn" | "tool" | "request" | "compacting" | "continued" | "retry" | "usage" | "coverage";
	text: string;
	turns?: number;
	usage?: WorkerUsage;
};
export type WorkerResult<T> =
	| { ok: true; value: T; usage: WorkerUsage; dependencies?: SourceEffect[] }
	| {
			ok: false;
			error: string;
			usage: WorkerUsage;
			permissionFailure?: boolean;
			dependencies?: SourceEffect[];
	  };
function providerFailureReason(error: unknown): string {
	const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
	if (/context[_ ](?:length|window)|too many tokens|token.*limit/i.test(text))
		return "Provider context window exhausted";
	if (/rate.?limit|too many requests|\b429\b/i.test(text)) return "Provider rate limited the review request";
	if (/unauthori[sz]ed|authentication|\b401\b|\b403\b/i.test(text)) return "Provider authentication failed";
	if (/timeout|timed out|deadline/i.test(text)) return "Provider request timed out";
	if (/ECONN|ENOTFOUND|network|connection/i.test(text)) return "Provider connection failed";
	return "Worker/provider request failed";
}
function failure(
	model: Model<Api>,
	aborted: boolean,
	overflow = false,
	reason = "Worker/provider request failed",
): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		model: model.id,
		provider: model.provider,
		timestamp: Date.now(),
		content: [],
		stopReason: aborted ? "aborted" : "error",
		errorMessage: aborted ? "Worker cancelled" : overflow ? "Worker context exceeds model window" : reason,
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
/** Public registry bridge. Only an individual request has a liveness timeout, never the whole worker. */
export function registryStream(
	registry: Registry,
	config: Config,
	request?: () => void,
	response?: (message: AssistantMessage) => void,
	permission?: { scope: PermissionScope; wait: PermissionWait; denied(error: PermissionBlocked): void },
): StreamFn {
	return (model, context, options) => {
		const output = createAssistantMessageEventStream();
		const controller = new AbortController();
		const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		let closed = false,
			overflow = false,
			reason = "Worker/provider request failed";
		const fail = () => {
			if (closed) return;
			closed = true;
			const error = failure(model, Boolean(options?.signal?.aborted), overflow, reason);
			response?.(error);
			output.push({ type: "error", reason: error.stopReason === "aborted" ? "aborted" : "error", error });
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const armTimer = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				reason = "Provider request timed out";
				controller.abort();
				fail();
			}, normalizeConfig(config).requestTimeoutMs);
		};
		signal.addEventListener("abort", fail, { once: true });
		void (async () => {
			try {
				if (signal.aborted) return fail();
				let revision = permission
					? await permission.wait(() => permission.scope.beforeDispatch(signal))
					: undefined;
				if (closed || signal.aborted) return fail();
				armTimer();
				request?.();
				const auth = await registry.getApiKeyAndHeaders(model);
				if (closed || signal.aborted) return fail();
				const provider = registry.getProvider(model.provider);
				if (!auth.ok || !provider) return fail();
				const effective = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
				const requestOptions = {
					...options,
					signal,
					...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
					headers: { ...auth.headers, ...options?.headers },
					env: { ...auth.env, ...options?.env },
					timeoutMs: normalizeConfig(config).requestTimeoutMs,
					maxRetries: 1,
					maxRetryDelayMs: 10000,
				};
				// Authentication and permit reacquisition may both outlive a permission revision.
				// Human approval is not provider liveness time. Check again with no await before dispatch.
				clearTimeout(timer);
				while (permission && revision !== permission.scope.revision()) {
					revision = await permission.wait(() => permission.scope.beforeDispatch(signal));
					if (closed || signal.aborted) return fail();
				}
				if (closed || signal.aborted) return fail();
				armTimer();
				const stream = provider.streamSimple(effective, context, requestOptions);
				for await (const event of stream) {
					if (closed) break;
					timer?.refresh();
					if (event.type === "done" || event.type === "error")
						response?.(event.type === "done" ? event.message : event.error);
					output.push(event);
					if (event.type === "done" || event.type === "error") {
						closed = true;
						break;
					}
				}
				if (!closed) fail();
			} catch (error) {
				if (isPermissionBlocked(error)) permission?.denied(error);
				reason = isPermissionBlocked(error) ? error.message : providerFailureReason(error);
				overflow =
					error instanceof Error &&
					/context[_ ](?:length|window)|too many tokens|token.*limit/i.test(error.message);
				fail();
			} finally {
				clearTimeout(timer);
				signal.removeEventListener("abort", fail);
			}
		})();
		// Also settle resources if authentication/provider ignores cancellation indefinitely.
		output
			.result()
			.finally(() => {
				clearTimeout(timer);
				signal.removeEventListener("abort", fail);
			})
			.catch(() => {});
		return output;
	};
}
export async function runWorker<T extends TSchema>(options: {
	registry: Registry;
	config: Config;
	schema: T;
	system: string;
	input: unknown;
	/** Stable for this logical task, including host-level recovery; never shared by concurrent workers. */
	sessionId?: string;
	continuing?: boolean;
	/** Small lens instruction repeated when task metadata must be paged or context is compacted. */
	assignment?: unknown;
	sharedResources?: AsyncIterable<import("./worker-context.js").ContextResource>;
	tools?: AgentTool[];
	permissions?: PermissionScope;
	/** Only used at input/provider boundaries where no sibling tools are executing. */
	suspendPermissions?: PermissionWait;
	/** Host-owned provenance for source-derived input from another worker. */
	dependencies?: readonly SourceEffect[];
	signal?: AbortSignal;
	progress?: (text: string) => void;
	event?: (event: WorkerEvent) => void;
	coverage?: CoverageLedger | undefined;
	resources?: AsyncIterable<{ id: string; text: string; total: number }> | undefined;
	allowAdvisories?: boolean;
	allowFindings?: boolean;
	validateCheckpoint?: ((value: Checkpoint) => void | Promise<void>) | undefined;
	validateResult?: ((value: Static<T>) => void | Promise<void>) | undefined;
	recover?: ((reason: string) => Promise<void>) | undefined;
}): Promise<WorkerResult<Static<T>>> {
	let usage = emptyUsage();
	const permission = options.permissions;
	if (!permission)
		return { ok: false, error: "Worker requires the permission service", usage, permissionFailure: true };
	permission.endTurn();
	const wait: PermissionWait = options.suspendPermissions ?? ((operation) => operation());
	let permissionFailure: PermissionBlocked | undefined;
	const model = options.registry.find(options.config.provider, options.config.model);
	if (!model || !options.registry.hasConfiguredAuth(model))
		return { ok: false, error: "Independent review model unavailable; use /pr model", usage };
	const emit = (event: WorkerEvent) => {
		try {
			options.progress?.(redact(event.text));
		} catch {
			/* Presentation cannot fail model work. */
		}
		try {
			options.event?.({ ...event, text: redact(event.text) });
		} catch {
			/* Retired observers are non-authoritative. */
		}
	};
	let summarizing = false,
		ordinaryRequests = options.continuing ? 1 : 0;
	let requestKind: RequestKind = "first";
	const stream = registryStream(
		options.registry,
		options.config,
		() => {
			requestKind = summarizing ? "compaction" : ordinaryRequests++ === 0 ? "first" : "continuation";
			usage.byRequest![requestKind].requests++;
			emit({ type: "request", text: "Model request" });
		},
		(message) => {
			usage = sumUsage(usage, providerUsage(message.usage, requestKind));
			emit({ type: "usage", text: "Usage updated", usage: structuredClone(usage) });
		},
		{
			scope: permission,
			wait,
			denied: (error) => {
				permissionFailure = error;
			},
		},
	);
	let submitted = false,
		invalidSubmission = false,
		turns = 0,
		compact = false,
		stalled = false;
	const recentSignatures: string[] = [];
	let inputText = "";
	const inputDelivery = new CoverageLedger(["task:input"]);
	let result: Static<T> | undefined;
	const textResult = (value: unknown) => ({
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: {},
	});
	const extra: AgentTool[] = [
		{
			name: "read_task_input",
			label: "Read task context",
			description:
				"Page the complete original JSON task input when it is too large to inline. Cursor counts characters.",
			parameters: Type.Object({ cursor: Type.Optional(Type.Integer({ minimum: 0 })) }),
			async execute(_id, args) {
				const cursor = (args as { cursor?: number }).cursor ?? 0;
				const text = inputText.slice(cursor, cursor + 8000);
				inputDelivery.deliver("task:input", cursor, cursor + text.length, inputText.length);
				return textResult({
					text,
					nextOffset: cursor + text.length < inputText.length ? cursor + text.length : null,
				});
			},
		},
	];
	if (options.coverage) {
		const ledger = options.coverage;
		extra.push({
			name: "record_checkpoint",
			label: "Record review checkpoint",
			description:
				"Optionally save intermediate findings or cross-file notes during a large review. No keys, read acknowledgments, or coverage IDs are required. Submit final findings directly through submit_result when they fit.",
			parameters: CheckpointSchema,
			executionMode: "sequential",
			async execute(_id, args) {
				const value = validate(CheckpointSchema, args);
				if (value.findings?.length && options.allowFindings === false)
					throw new Error("This stage must not invent findings");
				if (value.advisories?.length && !options.allowAdvisories)
					throw new Error("Only architecture may submit advisories");
				await options.validateCheckpoint?.(value);
				ledger.checkpoint(value);
				deferToolCommit(() =>
					emit({
						type: "coverage",
						text: `${ledger.total - ledger.remaining.length}/${ledger.total} obligations reviewed`,
					}),
				);
				return textResult({ accepted: value.key, remaining: ledger.remaining.length });
			},
		} as AgentTool);
		extra.push({
			name: "coverage_state",
			label: "Review coverage",
			description:
				"List context not yet supplied. Read task:input with read_task_input, diff:path with read_change, doc:path with read, and candidate:ID with read_candidate. Normal reads and inline context are tracked automatically; no acknowledgment tool call is necessary.",
			parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
			async execute(_id, args) {
				const offset = (args as { offset?: number }).offset ?? 0;
				const remaining = [...inputDelivery.remaining, ...ledger.remaining];
				return textResult({
					total: ledger.total + 1,
					remaining: remaining.slice(offset, offset + 100),
					nextOffset: offset + 100 < remaining.length ? offset + 100 : null,
				});
			},
		});
		extra.push({
			name: "checkpoint_notes",
			label: "Cross-file notes",
			description:
				"Page accepted cross-file checkpoint notes after continuation/compaction. Offset counts checkpoints.",
			parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
			async execute(_id, args) {
				const offset = (args as { offset?: number }).offset ?? 0;
				return textResult({
					notes: ledger.notes.slice(offset, offset + 4),
					nextOffset: offset + 4 < ledger.notes.length ? offset + 4 : null,
				});
			},
		});
	}
	if (options.recover)
		extra.push({
			name: "report_blocker",
			label: "Report review blocker",
			description:
				"Pause this task for a human to resolve missing context or a genuine failure. Other review tasks may continue. Explain the specific obstacle; do not loop on failed reads or pretend the review is complete.",
			executionMode: "sequential",
			parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 1000 }) }),
			async execute(_id, args) {
				await options.recover!(redact((args as { reason: string }).reason));
				return textResult({
					resumed: true,
					instruction: "Retry the blocked work against the same snapshot.",
				});
			},
		});
	const submit: AgentTool<T> = {
		name: "submit_result",
		label: "Submit result",
		description:
			"Submit the final review result. All assigned source must have been supplied to you, either inline or through normal reads. Intermediate result recording is optional.",
		parameters: options.schema,
		executionMode: "sequential",
		async execute(_id, args) {
			if (submitted) {
				invalidSubmission = true;
				throw new Error("Duplicate final submission");
			}
			const value = validate(options.schema, args);
			if (options.coverage && (value as { complete?: boolean }).complete === false) {
				const partial = value as { limitations?: string[]; findings?: Checkpoint["findings"] };
				const reason = redact(partial.limitations?.join("; ") || "Reviewer reported unfinished work");
				const checkpoint: Checkpoint = { findings: partial.findings ?? [], notes: reason };
				await options.validateCheckpoint?.(checkpoint);
				options.coverage.checkpoint(checkpoint);
				if (!options.recover) throw new Error(reason);
				await options.recover(reason);
				return textResult({
					resumed: true,
					instruction: "Continue the unfinished review; saved partial findings need not be repeated.",
				});
			}
			inputDelivery.assertComplete();
			options.coverage?.assertComplete();
			await options.validateResult?.(value);
			deferToolCommit(() => {
				result = value;
				submitted = true;
			});
			return { ...textResult({ accepted: true }), terminate: true };
		},
	};
	const tools: AgentTool[] = [...(options.tools ?? []), ...extra, submit as AgentTool].map((tool) => ({
		...tool,
		async execute(id, args, signal, onUpdate) {
			try {
				return await commitToolResult(() =>
					permission.guard(
						{
							toolName: tool.name,
							input: args,
							callId: id,
							description: `Invoke ${tool.name}: ${tool.description}`.slice(0, 4000),
							...(signal ? { signal } : {}),
						},
						() => tool.execute(id, args, signal, onUpdate),
					),
				);
			} catch (error) {
				if (isPermissionBlocked(error) && (tool.name === "submit_result" || error.kind !== "denied"))
					permissionFailure = error;
				throw error;
			}
		},
	}));
	const threshold = model.contextWindow - responseReserve(model);
	const system =
		options.system +
		(options.coverage
			? "\nReview the entire assigned scope. sharedContext and suppliedContext contain complete captured resources already provided to you. Shared documentation is background evidence; the lens assignment precedes the captured diffs. Read remaining sources normally; context delivery is tracked automatically. No read receipts or checkpoints are required. Use record_checkpoint only if you want to preserve intermediate findings/notes. Saved profile context is advisory; current captured code and documentation take precedence."
			: "");
	const agent: Agent = new Agent({
		initialState: {
			model,
			systemPrompt: system,
			thinkingLevel: model.reasoning ? options.config.thinking : "off",
			tools,
		},
		streamFn: stream,
		sessionId: options.sessionId ?? randomUUID(),
		shouldStopAfterTurn: ({ message, toolResults }) => {
			compact =
				contextTokens(
					system,
					tools.map((t) => ({ name: t.name, parameters: t.parameters })),
					agent.state.messages,
				) > threshold;
			const signature = JSON.stringify({
				calls: message.content
					.filter((block) => block.type === "toolCall")
					.map((block) => ({ name: block.name, arguments: block.arguments })),
				results: toolResults.map((result) => ({
					toolName: result.toolName,
					content: result.content,
					isError: result.isError,
				})),
				content: toolResults.length ? undefined : message.content,
				remaining: options.coverage?.remaining,
				checkpoints: options.coverage?.notes.length,
			});
			recentSignatures.push(signature);
			if (recentSignatures.length > 24) recentSignatures.shift();
			stalled = recentSignatures.filter((value) => value === signature).length >= 4;
			return submitted || compact || stalled || Boolean(permissionFailure);
		},
		beforeToolCall: async () => {
			if (!submitted) return undefined;
			invalidSubmission = true;
			return { block: true, reason: "Worker already submitted", terminate: true };
		},
	});
	const unsubscribe = agent.subscribe((event) => {
		if (event.type === "turn_start") {
			try {
				permission.nextTurn();
			} catch (error) {
				permissionFailure = isPermissionBlocked(error)
					? error
					: new PermissionBlocked("unavailable", "Permission service unavailable");
			}
			emit({ type: "turn", text: `turn ${++turns}`, turns });
		}
		if (event.type === "turn_end") permission.endTurn();
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			const path =
				event.type === "tool_execution_start" &&
				event.args &&
				typeof event.args.path === "string" &&
				!event.args.path.startsWith("/") &&
				!event.args.path.split("/").includes("..")
					? `: ${event.args.path.slice(0, 1024)}`
					: "";
			emit({
				type: "tool",
				text: `${event.toolName}${path}${event.type === "tool_execution_end" ? (event.isError ? " failed" : " finished") : ""}`,
			});
		}
	});
	const abort = () => agent.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	const recover = async (reason: string) => {
		if (!options.recover) throw new Error(reason);
		emit({ type: "retry", text: reason });
		await options.recover(reason);
		options.signal?.throwIfAborted();
	};
	try {
		await wait(() =>
			permission.authorizeSources(
				options.dependencies ?? [],
				"Receive source-derived results from another review worker",
				options.signal,
			),
		);
		inputText = JSON.stringify(options.input);
		if (contextTokens(system, tools, []) >= threshold)
			throw new Error("Model context cannot fit the review policy/tools; select a larger-context model");
		const overhead = contextTokens(system, tools, []);
		// Pi's text-only estimate is ceil(chars / 4); retain a final SDK check before crediting delivery.
		const fitsLength = (chars: number) => overhead + Math.ceil(chars / 4) <= threshold * 0.75;
		const fits = (text: string) =>
			contextTokens(system, tools, [{ role: "user", timestamp: 0, content: [{ type: "text", text }] }]) <=
			threshold * 0.75;
		if (options.resources && fitsLength(inputText.length)) {
			const resources = options.resources;
			const packed = await packInlineContext(
				inputText,
				resources,
				fitsLength,
				options.signal,
				options.sharedResources
					? {
							resources: options.sharedResources,
							// A fixed shared-prefix budget, independent of the lens/header length.
							fitsLength: (chars) => overhead + Math.ceil(chars / 4) <= threshold * 0.25,
						}
					: undefined,
			);
			if (fits(packed.text)) {
				inputText = packed.text;
				for (const resource of packed.delivered)
					options.coverage?.deliver(resource.id, 0, resource.total, resource.total);
				emit({ type: "coverage", text: `${packed.delivered.length} complete resources supplied inline` });
			}
		}
		const inlineInput = fits(inputText);
		if (inlineInput) inputDelivery.deliver("task:input", 0, inputText.length, inputText.length);
		const assignment =
			options.assignment === undefined ? "" : JSON.stringify({ assignment: options.assignment }) + "\n";
		const pagedPrompt =
			assignment +
			"Read the complete original task context through read_task_input before working. Continue its character cursor until nextOffset is null. All referenced captured changes/documents remain available through snapshot tools.";
		if (!inlineInput && !fits(pagedPrompt))
			throw new Error("Model context cannot fit the reviewer assignment; select a larger-context model");
		let prompt = inlineInput ? inputText : pagedPrompt;
		let previousStop = "",
			repeated = 0;
		for (;;) {
			options.signal?.throwIfAborted();
			await agent.prompt(prompt);
			options.signal?.throwIfAborted();
			if (permissionFailure) throw permissionFailure;
			if (submitted && result !== undefined) {
				if (invalidSubmission || agent.state.errorMessage)
					throw new Error("Worker violated final submission protocol");
				return { ok: true, value: result, usage, dependencies: permission.dependencies };
			}
			const overflow = /context|token.*limit|too (?:long|large)/i.test(agent.state.errorMessage ?? "");
			if (stalled) {
				await recover("Repeated identical activity without review progress");
				stalled = false;
				recentSignatures.length = 0;
			} else if (compact || overflow) {
				try {
					emit({ type: "compacting", text: "Compacting context; coverage retained" });
					summarizing = true;
					const messages = await compactWorkerContext({
						messages: agent.state.messages,
						model,
						stream,
						signal: options.signal,
						onUsage: () => {}, // Usage is recorded at the stream boundary, including retries.
					});
					agent.state.messages = assignment
						? [
								{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: assignment }] },
								...messages,
							]
						: messages;
					compact = false;
					emit({ type: "continued", text: "Continuing same review task" });
				} catch {
					options.signal?.throwIfAborted();
					if (permissionFailure) throw permissionFailure;
					await recover("Context compaction failed");
				} finally {
					summarizing = false;
				}
			} else if (agent.state.errorMessage) {
				await recover(providerFailureReason(agent.state.errorMessage));
				if (agent.state.messages.at(-1)?.role === "assistant")
					agent.state.messages = agent.state.messages.slice(0, -1);
			} else {
				const stop = JSON.stringify({
					remaining: options.coverage?.remaining,
					last: (agent.state.messages.at(-1) as { content?: unknown } | undefined)?.content,
				});
				repeated = stop === previousStop ? repeated + 1 : 0;
				previousStop = stop;
				if (!options.coverage || repeated >= 2) {
					await recover("Worker stopped without completing its structured submission");
					repeated = 0;
				}
			}
			prompt =
				"Continue the same task. Inspect remaining coverage and prior checkpoint notes; finish required work, then submit_result. Do not repeat recorded findings.";
		}
	} catch (error) {
		return {
			ok: false,
			error: options.signal?.aborted ? "Cancelled" : error instanceof Error ? error.message : "Worker failed",
			usage,
			...(isPermissionBlocked(error) ? { permissionFailure: true } : {}),
			dependencies: permission.dependencies,
		};
	} finally {
		permission.endTurn();
		unsubscribe();
		options.signal?.removeEventListener("abort", abort);
		agent.clearAllQueues();
	}
}
