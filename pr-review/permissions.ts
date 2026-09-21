import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Repo } from "./types.js";

// Versioned structural protocol. No runtime import/bundled copy of the permission extension.
export const REVIEW_SERVICE_CHANNEL = "permissions:review-service:v1";
export const WORKER_CONTROL_TOOLS = [
	"read_task_input",
	"record_checkpoint",
	"coverage_state",
	"checkpoint_notes",
	"report_blocker",
	"submit_result",
] as const;
export type PermissionWait = <T>(operation: () => Promise<T>) => Promise<T>;
export interface SourceEffect {
	path: string;
	side?: "old" | "new";
	version?: string;
	range?: string;
}
export interface PermissionAction {
	toolName: string;
	input: unknown;
	effects?: readonly SourceEffect[];
	description?: string;
	callId?: string;
	signal?: AbortSignal | undefined;
}
export type PermissionResult =
	| { kind: "allowed"; revision: string }
	| { kind: "denied" | "cancelled" | "unavailable"; reason: string };
export interface TaskPort {
	check(action: PermissionAction): Promise<PermissionResult>;
	revision(): string;
	nextTurn(): void;
	endTurn(): void;
	close(): void;
}
export interface TaskSpec {
	id: string;
	name: string;
	assignment: string;
	model: string;
	tools: readonly string[];
	kind: "host" | "worker";
	signal?: AbortSignal;
}
export interface OperationPort {
	task(spec: TaskSpec): TaskPort;
	close(): void;
}
interface HostSkill {
	name: string;
	filePath: string;
	baseDir: string;
}
interface ServicePort {
	version: 1;
	open(options: {
		id: string;
		sessionId: string;
		cwd: string;
		scope: string;
		signal: AbortSignal;
		command?: string;
		parentToolCallId?: string;
		skills?: readonly HostSkill[];
	}): OperationPort;
}

export class PermissionBlocked extends Error {
	readonly code = "PR_PERMISSION";
	constructor(
		readonly kind: "denied" | "cancelled" | "unavailable",
		message: string,
	) {
		super(message);
		this.name = "PermissionBlocked";
	}
}
export function isPermissionBlocked(error: unknown): error is PermissionBlocked {
	return error instanceof PermissionBlocked;
}

/** Source/turn state, not an approval cache. The service alone owns classifier memoization. */
export class PermissionScope {
	private readonly used = new Map<string, SourceEffect>();
	constructor(private readonly port: TaskPort) {}
	get dependencies(): SourceEffect[] {
		return [...this.used.values()].map((source) => ({ ...source }));
	}
	revision(): string {
		try {
			return this.port.revision();
		} catch {
			throw new PermissionBlocked("unavailable", "Permission service/config unavailable.");
		}
	}
	nextTurn(): void {
		this.port.nextTurn();
	}
	endTurn(): void {
		this.port.endTurn();
	}
	close(): void {
		this.port.close();
	}
	async authorize(action: PermissionAction): Promise<string> {
		let result: PermissionResult;
		try {
			result = await this.port.check(action);
		} catch {
			throw new PermissionBlocked("unavailable", "Permission service/config unavailable.");
		}
		if (!result || !["allowed", "denied", "cancelled", "unavailable"].includes(result.kind))
			throw new PermissionBlocked("unavailable", "Invalid permission service response.");
		if (result.kind !== "allowed") throw new PermissionBlocked(result.kind, result.reason);
		if (typeof result.revision !== "string" || !result.revision)
			throw new PermissionBlocked("unavailable", "Missing permission revision.");
		action.signal?.throwIfAborted();
		return result.revision;
	}
	async guard<T>(action: PermissionAction, read: () => Promise<T>): Promise<T> {
		let revision = await this.authorize(action);
		// Re-evaluate if another microtask changed policy after the verdict settled.
		while (revision !== this.revision()) revision = await this.authorize(action);
		const result = await read();
		action.signal?.throwIfAborted();
		while (revision !== this.revision()) revision = await this.authorize(action);
		for (const { range: _range, ...source } of action.effects ?? []) {
			this.used.set(JSON.stringify(source), source);
		}
		return result;
	}
	async authorizeSources(
		sources: readonly SourceEffect[],
		description: string,
		signal?: AbortSignal,
	): Promise<string> {
		// This set and its revision belong to one transfer, never a reusable grant.
		const unique = new Map<string, SourceEffect>();
		let processed = 0;
		const yieldToUI = async () => {
			signal?.throwIfAborted();
			await new Promise<void>((resolve) => setImmediate(resolve));
			signal?.throwIfAborted();
		};
		for (const source of sources) {
			signal?.throwIfAborted();
			unique.set(JSON.stringify(source), source);
			if (++processed % 32 === 0) await yieldToUI();
		}
		for (;;) {
			signal?.throwIfAborted();
			const revision = this.revision();
			let stable = true;
			for (const source of unique.values()) {
				await this.guard(
					{
						toolName: "read",
						input: { path: source.path },
						effects: [source],
						description,
						...(signal ? { signal } : {}),
					},
					async () => undefined,
				);
				if (++processed % 32 === 0) await yieldToUI();
				if (revision !== this.revision()) {
					stable = false;
					break;
				}
			}
			signal?.throwIfAborted();
			if (stable && revision === this.revision()) return revision;
			// Revisit A if its approval became stale while B was pending, including tiny batches.
			await yieldToUI();
		}
	}
	async beforeDispatch(signal?: AbortSignal): Promise<string> {
		// A summary cannot reliably be redacted. Recheck the conservative source set instead.
		return this.authorizeSources(
			this.dependencies,
			"Continue using captured source in this worker's model context",
			signal,
		);
	}
}

export class ReviewPermissions {
	private readonly scopes = new Set<PermissionScope>();
	constructor(
		readonly id: string,
		private readonly port: OperationPort,
		private readonly unsubscribe: () => void = () => {},
	) {}
	get dependencies(): SourceEffect[] {
		const sources = new Map<string, SourceEffect>();
		for (const scope of this.scopes)
			for (const source of scope.dependencies) sources.set(JSON.stringify(source), source);
		return [...sources.values()];
	}
	task(spec: TaskSpec): PermissionScope {
		const port = this.port.task(spec);
		if (
			!port ||
			typeof port.check !== "function" ||
			typeof port.revision !== "function" ||
			typeof port.nextTurn !== "function" ||
			typeof port.endTurn !== "function" ||
			typeof port.close !== "function"
		)
			throw new PermissionBlocked("unavailable", "Incompatible permission task service.");
		const scope = new PermissionScope(port);
		this.scopes.add(scope);
		return scope;
	}
	host(name: string, id = `host:${randomUUID()}`): PermissionScope {
		return this.task({
			id,
			name,
			assignment: name,
			model: "local preparation",
			tools: ["read", "read_change", "list_source", "search_source"],
			kind: "host",
		});
	}
	close(): void {
		for (const scope of this.scopes) scope.close();
		this.scopes.clear();
		this.unsubscribe();
		this.port.close();
	}
}

export function openReviewPermissions(
	pi: Pick<ExtensionAPI, "events">,
	ctx: ExtensionContext,
	repo: Repo,
	scope: string,
	signal: AbortSignal,
	launch: { command?: string; parentToolCallId?: string } = {},
	activity?: (event: { taskId: string; requestId: string; state: "queued" | "showing" | "finished" }) => void,
): ReviewPermissions {
	const candidates: unknown[] = [];
	let discovering = true;
	pi.events.emit(REVIEW_SERVICE_CHANNEL, {
		version: 1,
		accept: (value: unknown) => {
			if (discovering) candidates.push(value);
		},
	});
	discovering = false;
	const service = candidates[0] as ServicePort | undefined;
	if (candidates.length !== 1 || service?.version !== 1 || typeof service.open !== "function")
		throw new PermissionBlocked(
			"unavailable",
			"PR review requires the loaded compatible Permission System extension. Load it and /reload.",
		);
	const id = randomUUID();
	// Slash commands can run before before_agent_start populated the owner's skill catalogue.
	const commandContext = ctx as ExtensionContext & {
		getSystemPromptOptions?: () => { skills?: HostSkill[] };
	};
	const skills = commandContext
		.getSystemPromptOptions?.()
		.skills?.map(({ name, filePath, baseDir }) => ({ name, filePath, baseDir }));
	const port = service.open({
		id,
		cwd: repo.root,
		sessionId: ctx.sessionManager.getSessionId(),
		scope,
		signal,
		...(skills ? { skills } : {}),
		...launch,
	});
	if (!port || typeof port.task !== "function" || typeof port.close !== "function")
		throw new PermissionBlocked("unavailable", "Incompatible permission operation service.");
	const unsubscribe = pi.events.on("permissions:review_state", (raw) => {
		if (!raw || typeof raw !== "object") return;
		const event = raw as {
			requestId?: unknown;
			state?: unknown;
			delegated?: { operationId?: unknown; taskId?: unknown };
		};
		if (
			event.delegated?.operationId !== id ||
			typeof event.delegated.taskId !== "string" ||
			typeof event.requestId !== "string" ||
			(event.state !== "queued" && event.state !== "showing" && event.state !== "finished")
		)
			return;
		try {
			activity?.({ taskId: event.delegated.taskId, requestId: event.requestId, state: event.state });
		} catch {
			/* activity is not permission authority */
		}
	});
	return new ReviewPermissions(id, port, unsubscribe);
}
