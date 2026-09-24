import { resolve } from "node:path";
import type { BoundaryResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, saveConfig, type QualityConfig } from "./config.js";
import { buildReviewChunks, canonicalPath, CoverageError, readSnapshot } from "./capture.js";
import {
	newCase,
	proposalApplied,
	recordVerdict,
	requestReconsideration,
	resolveCase,
	revision,
	type QualityCase,
} from "./case.js";
import { exclusionRule } from "./exclusions.js";
import {
	applyExactEdits,
	digest,
	type ValidatedVerdict,
	type ProposedEdit,
	type Finding,
} from "./proposal.js";
import { POLICY, review, type ReviewResult } from "./reviewer.js";
import { CaseStore, latestReference, STATE_ENTRY } from "./state.js";
import type { QualityActivityPhase, QualityActivityPublisher, QualityActivityStatus } from "./activity.js";
import {
	CHECKING_QUALITY_LABEL,
	QUALITY_CHECK_ENTRY,
	qualityFeedbackLabel,
	type QualityFeedbackDetails,
} from "./feedback.js";

export interface Decision {
	choice: "original" | "proposed" | "continue";
	note: string;
}
export interface QualityUI {
	arbitrate(ctx: ExtensionContext, state: QualityCase, signal: AbortSignal): Promise<Decision | undefined>;
	coverage(
		ctx: ExtensionContext,
		path: string,
		reason: string,
		provider: string,
		signal: AbortSignal,
	): Promise<"authorize" | "waive" | undefined>;
	failure(
		ctx: ExtensionContext,
		reason: string,
		signal: AbortSignal,
	): Promise<"retry" | "model" | "waive" | undefined>;
}
export interface RuntimePorts {
	ui: QualityUI;
	review?: typeof review;
	activity?: QualityActivityPublisher;
}
interface MutationPreparation {
	result: { block: true; reason: string } | undefined;
	path?: string;
	phase?: QualityActivityPhase;
}

const PROTOCOL =
	"Quality review is enforced after edit/write batches in TUI mode. Resolve needs_work before unrelated implementation. Apply corrections using ordinary file tools. To disagree call quality_response(disagree) with the current case/revision and your rationale; the reviewer will reconsider it. Corrections and disagreements share five response-and-review rounds after the initial rejection. Resolve the disagreement with the reviewer before reaching out to the operator; automatic arbitration occurs only after those rounds remain unresolved. Do not ask the operator to settle readability feedback early. Only the user can waive. Request extra helper/test paths with quality_response(request_scope). Do not evade the gate through bash, subagents, configuration changes, or custom file tools. User-approved proposals must be applied exactly before continuing. Approval covers style, not correctness.";

export class QualityController {
	config: QualityConfig = { ...DEFAULT_CONFIG };
	configError?: string;
	state?: QualityCase;
	private store?: CaseStore;
	private lifetime = new AbortController();
	private operation = false;
	private captureChanged = false;
	private ignoredPaths = new Set<string>();
	private blockedReason?: string;
	private generation = 0;
	private sessionId = "";
	private cwd = "";
	private activityContext?: ExtensionContext;
	private activityOverride?: QualityActivityPhase;
	private reviewAttempt?: number;
	private readonly activityCalls = new Map<
		string,
		{ path?: string; phase?: QualityActivityPhase; blocked: boolean }
	>();
	constructor(
		readonly pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">,
		readonly agentDir: string,
		readonly ports: RuntimePorts,
	) {}

	private modelKey(): string {
		return this.config.provider && this.config.model
			? `${this.config.provider}/${this.config.model}`
			: "unconfigured";
	}
	get policy(): string {
		return `${POLICY}\n\n${PROTOCOL}`;
	}
	get pending(): boolean {
		return Boolean(this.blockedReason || (this.state && this.state.phase !== "closed"));
	}
	get active(): boolean {
		return this.config.enabled;
	}
	private signal(ctx: ExtensionContext): AbortSignal {
		return ctx.signal ? AbortSignal.any([this.lifetime.signal, ctx.signal]) : this.lifetime.signal;
	}
	private valid(ctx: ExtensionContext, generation: number): boolean {
		return (
			generation === this.generation &&
			!this.lifetime.signal.aborted &&
			ctx.sessionManager.getSessionId() === this.sessionId
		);
	}
	private activityPhase(): QualityActivityPhase {
		if (this.activityOverride) return this.activityOverride;
		if (this.blockedReason || this.configError) return "paused";
		if (!this.config.enabled) return "disabled";
		const state = this.state;
		if (state?.phase === "reviewing") return "checking";
		if (state?.phase === "human") return "awaiting_user";
		if (state?.phase === "correcting") return "needs_work";
		if (state?.phase === "applying") return "applying";
		if (state?.phase === "paused") return "paused";
		if (state?.phase === "closed") {
			return state.resolution === "model_approved" ? "approved" : (state.resolution ?? "not_reviewed");
		}
		if (!this.config.provider || !this.config.model) return "unconfigured";
		return state ? "pending" : "ready";
	}
	private publishActivity(): void {
		if (!this.ports.activity || this.activityContext?.mode !== "tui") return;
		const state = this.state;
		const phase = this.activityPhase();
		const status: QualityActivityStatus = {
			phase,
			...(state && state.phase !== "closed"
				? { correctionAttempt: state.attempts, correctionLimit: state.limit }
				: {}),
			...(phase === "checking" && this.reviewAttempt !== undefined
				? { reviewAttempt: this.reviewAttempt }
				: {}),
		};
		this.ports.activity.updateHeader(status, this.modelKey());
		this.ports.activity.update(status);
	}
	private status(ctx: ExtensionContext, text?: string): void {
		this.publishActivity();
		ctx.ui.setStatus(
			"code-quality",
			`quality: ${text ?? (this.blockedReason ? "paused" : !this.config.enabled ? "off" : this.state?.phase === "closed" ? this.state.resolution : (this.state?.phase ?? this.modelKey()))}`,
		);
	}
	private receipt(content: string): void {
		this.pi.sendMessage(
			{
				customType: "code-quality:feedback",
				content,
				display: true,
				details: { outcome: "not_reviewed" } satisfies QualityFeedbackDetails,
			},
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
	}
	private persist(): void {
		if (this.state && this.store) this.pi.appendEntry(STATE_ENTRY, this.store.save(this.state));
		this.publishActivity();
	}
	private pause(ctx: ExtensionContext, reason: string): void {
		if (this.state) {
			this.state.phase = "paused";
			this.state.reason = reason;
		} else this.blockedReason = reason;
		try {
			this.persist();
		} catch (error) {
			this.blockedReason = `Quality state cannot be saved: ${String(error)}`;
		}
		this.status(ctx, "paused — /quality resolve");
		ctx.ui.notify(reason, "warning");
		ctx.abort();
	}
	start(ctx: ExtensionContext): void {
		this.dispose();
		this.lifetime = new AbortController();
		this.sessionId = ctx.sessionManager.getSessionId();
		this.activityContext = ctx;
		this.activityOverride = undefined;
		this.reviewAttempt = undefined;
		this.activityCalls.clear();
		this.ports.activity?.reset(this.sessionId);
		this.cwd = canonicalPath(ctx.cwd);
		this.state = undefined;
		this.store = undefined;
		this.blockedReason = undefined;
		this.ignoredPaths.clear();
		this.captureChanged = false;
		const loaded = loadConfig(this.agentDir);
		this.config = loaded.config;
		this.configError = loaded.error;
		if (ctx.mode !== "tui") {
			this.status(ctx, "inactive outside TUI");
			return;
		}
		try {
			this.store = new CaseStore(this.agentDir, this.cwd);
			const ref = latestReference(ctx.sessionManager.getBranch());
			if (ref) this.state = this.store.load(ref);
			if (this.state && this.state.phase !== "closed") {
				if (this.state.pendingPaths.length) this.state.phase = "captured";
				if (this.state.providerKey !== this.modelKey()) {
					this.state.authorized = [];
					this.state.providerKey = this.modelKey();
				}
				if (this.state.phase === "reviewing") this.state.phase = "captured";
				if (this.state.phase === "human" && this.state.attempts < this.state.limit) {
					requestReconsideration(this.state, this.state.objection);
				}
				this.checkFresh(ctx);
			}
		} catch (error) {
			this.blockedReason = `Quality recovery requires a user decision: ${String(error)}`;
		}
		this.status(ctx, this.configError ? "invalid configuration" : undefined);
	}
	dispose(): void {
		this.generation++;
		this.lifetime.abort();
		this.operation = false;
		this.activityContext = undefined;
		this.activityCalls.clear();
		this.ports.activity?.reset("");
	}
	summary(): string {
		if (this.blockedReason) return this.blockedReason;
		if (!this.state || this.state.phase === "closed")
			return `Quality ${this.config.enabled ? "enabled" : "disabled"}; reviewer ${this.modelKey()}. Explicit edit/write coverage only; shell/custom mutations are not automatically covered.`;
		return `Quality case ${this.state.id}; revision ${revision(this.state)}; ${this.state.phase}; rounds ${this.state.attempts}/${this.state.limit}. ${this.state.reason ?? ""}`;
	}
	private ensureCase(): QualityCase {
		if (!this.state || this.state.phase === "closed") this.state = newCase(this.cwd, this.modelKey());
		return this.state;
	}
	private authorized(path: string): boolean {
		return this.state?.authorized.includes(path) ?? false;
	}
	private snapshot(path: string): string | null {
		return readSnapshot(path, this.config, this.cwd, this.authorized(path));
	}
	private checkFresh(ctx: ExtensionContext): boolean {
		if (!this.state || this.state.phase === "closed") return true;
		for (const file of this.state.files) {
			if (this.state.pendingPaths.includes(file.path)) continue;
			const actual = this.snapshot(file.path);
			if (actual !== file.after) {
				file.after = actual;
				this.state.verdict = undefined;
				this.state.approvedTargets = undefined;
				this.state.phase = "captured";
				this.state.correctionPending = false;
				this.state.reconsiderationPending = false;
				this.state.objection = undefined;
				this.state.reason = "Tracked content changed outside the reviewed snapshot; review again";
				this.persist();
				this.status(ctx);
				return false;
			}
		}
		return true;
	}
	async beforeTool(
		toolName: string,
		input: Record<string, unknown>,
		ctx: ExtensionContext,
		toolCallId?: string,
	): Promise<{ block: true; reason: string } | undefined> {
		if (ctx.mode !== "tui" || !["edit", "write"].includes(toolName)) return;
		if (toolCallId) this.ports.activity?.begin(toolCallId);
		const generation = this.generation;
		let preparation: MutationPreparation;
		try {
			preparation = await this.prepareMutation(input, ctx);
		} catch (error) {
			if (toolCallId && this.valid(ctx, generation))
				this.ports.activity?.finishTool(toolCallId, "not_reviewed");
			throw error;
		}
		const { result, path, phase } = preparation;
		if (toolCallId && this.ports.activity && this.valid(ctx, generation)) {
			this.activityCalls.set(toolCallId, { path, phase, blocked: result?.block === true });
			if (phase) this.ports.activity.finishTool(toolCallId, phase);
		}
		return result;
	}
	finishTool(toolCallId: string, isError: boolean): void {
		const call = this.activityCalls.get(toolCallId);
		if (!call) return;
		if (isError && call.phase && !call.blocked) this.ports.activity?.finishTool(toolCallId, "not_reviewed");
		if (call.phase) this.activityCalls.delete(toolCallId);
	}
	private async prepareMutation(
		input: Record<string, unknown>,
		ctx: ExtensionContext,
	): Promise<MutationPreparation> {
		if (!this.config.enabled) return { result: undefined, phase: "disabled" };
		let path: string | undefined;
		const blocked = (reason: string): MutationPreparation => ({
			path,
			phase: "blocked",
			result: { block: true, reason },
		});
		try {
			const rawPath = input.path;
			if (typeof rawPath !== "string" || !rawPath.trim())
				return blocked("Quality gate requires an explicit file path");
			const requested = resolve(ctx.cwd, rawPath);
			path = canonicalPath(requested);
			const excluded = exclusionRule(requested, path);
			if (excluded) {
				this.pi.appendEntry("code-quality:excluded", {
					path,
					rule: excluded,
					status: "auto_approved",
					reviewed: false,
				});
				this.status(ctx, `auto-approved: ${excluded}`);
				return { result: undefined, path, phase: "excluded" };
			}
			if (this.blockedReason) return blocked(this.blockedReason);
			if (this.configError) return blocked(`${this.configError}; fix configuration and /reload`);
			const state = this.ensureCase();
			this.ignoredPaths.delete(path);
			if (
				state.phase === "captured" &&
				!state.pendingPaths.length &&
				state.files.some((file) => file.before !== file.after)
			)
				return blocked("A fresh quality verdict is pending; inspect the case before editing again.");
			if (["human", "paused"].includes(state.phase))
				return blocked(`${this.summary()} Resolve with /quality resolve before editing.`);
			if (["correcting", "applying"].includes(state.phase) && !state.scope.includes(path))
				return blocked(
					`Resolve case ${state.id} first, or request this helper/test path using quality_response(request_scope).`,
				);
			if (!this.checkFresh(ctx))
				return blocked("Review snapshot became stale; wait for a fresh verdict before editing.");
			if (state.phase === "applying" && state.approvedTargets?.[path] === digest(this.snapshot(path)))
				return blocked(
					"This file already matches the user-approved proposal. Apply only its remaining files.",
				);
			let before: string | null;
			try {
				before = this.snapshot(path);
			} catch (error) {
				if (error instanceof CoverageError && error.kind === "binary") {
					this.ignoredPaths.add(path);
					this.receipt(`Not reviewed (binary/non-UTF-8): ${path}`);
					return { result: undefined, path, phase: "not_reviewed" };
				}
				const generation = this.generation;
				const decision = await this.ports.ui.coverage(
					ctx,
					path,
					String(error),
					this.modelKey(),
					this.signal(ctx),
				);
				if (!this.valid(ctx, generation) || this.signal(ctx).aborted)
					return blocked("Quality decision cancelled");
				if (decision === "waive") {
					this.ignoredPaths.add(path);
					this.pi.appendEntry("code-quality:waiver", { path, reason: String(error) });
					return { result: undefined, path, phase: "not_reviewed" };
				}
				if (
					decision !== "authorize" ||
					(error instanceof CoverageError && !["sensitive", "external"].includes(error.kind))
				) {
					this.pause(ctx, String(error));
					return blocked("Quality review requires a coverage decision");
				}
				state.authorized.push(path);
				before = this.snapshot(path);
			}
			if (!state.files.some((file) => file.path === path)) state.files.push({ path, before, after: before });
			if (!state.scope.includes(path)) state.scope.push(path);
			if (!state.pendingPaths.includes(path)) state.pendingPaths.push(path);
			this.persist();
			return { result: undefined, path };
		} catch (error) {
			this.pause(ctx, `Quality capture failed: ${String(error)}`);
			return blocked("Quality capture failed; resolve before retrying");
		}
	}
	private async reconcile(ctx: ExtensionContext): Promise<boolean> {
		if (!this.state) return false;
		let changed = false;
		for (const path of this.state.pendingPaths) {
			const file = this.state.files.find((file) => file.path === path);
			if (!file || this.ignoredPaths.has(path)) continue;
			let after: string | null;
			try {
				after = this.snapshot(path);
			} catch (error) {
				const generation = this.generation;
				const decision =
					error instanceof CoverageError && error.kind === "binary"
						? "waive"
						: await this.ports.ui.coverage(ctx, path, String(error), this.modelKey(), this.signal(ctx));
				if (!this.valid(ctx, generation) || this.signal(ctx).aborted)
					throw new Error("Quality capture cancelled");
				if (decision === "waive") {
					this.state.files = this.state.files.filter((candidate) => candidate.path !== path);
					this.state.verdict = undefined;
					this.state.approvedTargets = undefined;
					this.state.phase = "captured";
					this.pi.appendEntry("code-quality:waiver", { path, reason: String(error), reviewed: false });
					this.receipt(`Quality not reviewed: ${path} (${String(error)})`);
					continue;
				}
				if (
					decision !== "authorize" ||
					!(error instanceof CoverageError) ||
					!["sensitive", "external"].includes(error.kind)
				)
					throw new Error(String(error));
				this.state.authorized.push(path);
				after = this.snapshot(path);
			}
			changed ||= after !== file.after;
			file.after = after;
		}
		this.state.pendingPaths = [];
		this.captureChanged ||= changed;
		if (changed && this.state.reviewed) {
			this.state.correctionPending = true;
			this.state.reconsiderationPending = false;
			this.state.objection = undefined;
		}
		this.persist();
		return changed;
	}
	private feedback(): string {
		const state = this.state!;
		return `${this.summary()}\n${state.verdict ? JSON.stringify({ verdict: state.verdict.verdict, rationale: state.verdict.rationale, findings: state.verdict.findings, edits: state.verdict.edits }) : (state.reason ?? "Review pending")}\nResolve the case before unrelated work. If you disagree, call quality_response with caseId, revision and rationale so the reviewer can reconsider. Corrections and disagreements share the round budget; do not ask the operator to settle the finding before that budget is exhausted. Do not self-waive.`;
	}
	private result(content: string, continueRun = true, details?: QualityFeedbackDetails): BoundaryResult {
		const displayDetails = details ?? this.feedbackDetails();
		this.activityContext?.ui.setStatus("code-quality", qualityFeedbackLabel(displayDetails));
		return {
			entries: [
				{
					type: "custom_message",
					customType: "code-quality:feedback",
					content,
					display: true,
					details: displayDetails,
				},
			],
			continue: continueRun,
		};
	}
	private feedbackDetails(): QualityFeedbackDetails {
		const state = this.state;
		if (state?.resolution === "waived") return { outcome: "waived" };
		if (state?.phase === "closed") {
			const outcome = state.resolution === "unchanged" ? "not_reviewed" : "approved";
			return { outcome };
		}
		if (state?.phase === "applying") return { outcome: "applying" };
		if (state?.verdict?.verdict === "needs_work")
			return { outcome: "rejected", rejection: state.attempts + 1 };
		return { outcome: "retrying" };
	}
	private finishActivityCollection(): void {
		for (const [id, call] of this.activityCalls) {
			if (call.phase) continue;
			const file = this.state?.files.find((file) => file.path === call.path);
			if (!file) this.ports.activity?.finishTool(id, "not_reviewed");
			else if (file.before === file.after) this.ports.activity?.finishTool(id, "unchanged");
		}
		this.activityCalls.clear();
		this.ports.activity?.finishCollection();
		this.publishActivity();
	}
	async boundary(
		ctx: ExtensionContext,
		outcome: string,
		settling = false,
	): Promise<BoundaryResult | undefined> {
		if (ctx.mode !== "tui" || !this.config.enabled || this.operation) return;
		if (this.blockedReason) {
			this.pause(ctx, this.blockedReason);
			return;
		}
		this.operation = true;
		this.activityOverride = undefined;
		this.reviewAttempt = undefined;
		const generation = this.generation;
		try {
			await this.reconcile(ctx);
			this.finishActivityCollection();
			if (outcome !== "completed" || this.signal(ctx).aborted) {
				if (this.pending) {
					this.state!.phase = "paused";
					this.state!.reason = "Interrupted; /quality retry resumes the pending review";
					this.persist();
				}
				return;
			}
			if (!this.state || this.state.phase === "closed") return;
			const state = this.state;
			if (this.configError) {
				this.pause(ctx, this.configError);
				return;
			}
			this.checkFresh(ctx);
			if (state.phase === "paused") {
				this.pause(ctx, state.reason ?? "Quality decision pending");
				return;
			}
			if (state.phase === "applying") {
				if (proposalApplied(state)) {
					state.phase = "closed";
					state.resolution = "user_approved";
					this.persist();
					this.status(ctx);
					return this.result(
						"Quality: exact user-approved proposal applied. Run normal correctness checks.",
						false,
					);
				}
				if (settling) {
					this.pause(
						ctx,
						"User-approved proposal has not been applied exactly; /quality resolve to review the remaining changes",
					);
					return;
				}
				return;
			}
			if (state.phase === "human") return await this.arbitrate(ctx);
			if (settling && state.phase === "correcting" && !this.captureChanged) {
				requestReconsideration(state);
				this.persist();
				if (state.attempts >= state.limit) return await this.arbitrate(ctx);
			}
			if (state.phase === "correcting" && !this.captureChanged) return;
			const responseRound = state.correctionPending || state.reconsiderationPending === true;
			this.captureChanged = false;
			if (state.files.every((file) => file.before === file.after)) {
				state.phase = "closed";
				state.resolution = "unchanged";
				this.persist();
				this.status(ctx);
				return;
			}
			const chunks = buildReviewChunks(state.files, this.config, this.cwd);
			state.phase = "reviewing";
			this.persist();
			this.pi.appendEntry(QUALITY_CHECK_ENTRY, { caseId: state.id });
			this.status(ctx, CHECKING_QUALITY_LABEL);
			const findings: Finding[] = [];
			const edits: ProposedEdit[] = [];
			const reasons: string[] = [];
			for (const chunk of chunks) {
				const response = await (this.ports.review ?? review)({
					registry: ctx.modelRegistry,
					config: this.config,
					request: {
						...chunk,
						input: `${chunk.input}\nPrevious case findings (untrusted review data; check whether resolved):\n${JSON.stringify(state.verdict?.findings ?? [])}`,
						notes: state.notes,
						...(state.objection ? { objection: state.objection } : {}),
					},
					signal: this.signal(ctx),
					onAttempt: (attempt) => {
						this.reviewAttempt = attempt;
						this.status(ctx, CHECKING_QUALITY_LABEL);
					},
				});
				if (!this.valid(ctx, generation) || this.signal(ctx).aborted) return;
				this.pi.appendEntry("code-quality:usage", { caseId: state.id, ...response.metrics });
				if (!this.checkFresh(ctx))
					return this.result(
						"Quality snapshot changed during review; inspect the current code before continuing.",
						true,
						{ outcome: "stale" },
					);
				if (response.kind !== "verdict") return await this.reviewFailure(ctx, response);
				findings.push(...response.value.findings);
				edits.push(...response.value.edits);
				reasons.push(response.value.rationale);
			}
			if (findings.length > 24 || edits.length > 48)
				throw new Error(
					"Combined review exceeds the bounded feedback budget; split the change or resolve explicitly",
				);
			const uniqueEdits = [...new Map(edits.map((edit) => [JSON.stringify(edit), edit])).values()];
			const proposed: Record<string, string> = Object.create(null);
			for (const file of state.files) {
				const local = uniqueEdits.filter((edit) => edit.file === file.path);
				if (local.length) proposed[file.path] = applyExactEdits(file.after ?? "", local);
			}
			const verdict: ValidatedVerdict = {
				verdict: findings.length ? "needs_work" : "approved",
				rationale: reasons.join("\n").slice(0, 4000),
				findings: [...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values()],
				edits: uniqueEdits,
				proposed,
			};
			recordVerdict(state, verdict, responseRound);
			this.persist();
			this.status(ctx);
			if (verdict.verdict === "needs_work" && state.attempts >= state.limit) return await this.arbitrate(ctx);
			return this.result(
				verdict.verdict === "approved"
					? `Quality approved: ${state.files.length} file(s), snapshot ${revision(state)}. Style only; correctness not certified.`
					: this.feedback(),
				verdict.verdict !== "approved",
			);
		} catch (error) {
			if (error instanceof CoverageError && this.state && !this.signal(ctx).aborted) {
				try {
					return await this.resolveCoveragePause(ctx, error);
				} catch (failure) {
					this.pause(ctx, `Quality coverage decision failed: ${String(failure)}`);
					return;
				}
			}
			this.pause(ctx, `Quality gate paused: ${String(error)}`);
			return;
		} finally {
			if (generation === this.generation) {
				this.ports.activity?.finishCollection();
				this.publishActivity();
				this.operation = false;
			}
		}
	}
	private async arbitrate(ctx: ExtensionContext): Promise<BoundaryResult | undefined> {
		const state = this.state!;
		state.phase = "human";
		this.persist();
		this.status(ctx);
		const expected = revision(state);
		const generation = this.generation;
		if (!state.verdict?.edits.length) {
			this.pause(ctx, "No current proposal to compare; use /quality retry for fresh review");
			return;
		}
		const choice = await this.ports.ui.arbitrate(ctx, state, this.signal(ctx));
		if (!this.valid(ctx, generation) || this.signal(ctx).aborted) return;
		if (!choice) {
			this.pause(ctx, "Quality arbitration cancelled; /quality resolve to reopen");
			return;
		}
		if (!this.checkFresh(ctx) || revision(state) !== expected) {
			this.pause(ctx, "Code changed while deciding; review again");
			return;
		}
		resolveCase(state, choice.choice, choice.note);
		this.persist();
		this.status(ctx);
		if (choice.choice === "proposed")
			return this.result(
				`User approved this exact proposal. Apply only these edits through ordinary tools, then run normal tests:\n${JSON.stringify(state.verdict!.edits)}\n${this.summary()}`,
			);
		return this.result(
			choice.choice === "original"
				? "Quality: user approved the current code for this case."
				: this.feedback(),
			choice.choice !== "original",
		);
	}
	private async reviewFailure(
		ctx: ExtensionContext,
		response: Exclude<ReviewResult, { kind: "verdict" }>,
	): Promise<BoundaryResult | undefined> {
		if (response.kind === "cancelled") {
			this.pause(ctx, response.reason);
			return;
		}
		const generation = this.generation;
		const expected = revision(this.state!);
		this.activityOverride =
			response.kind === "unavailable" && (!this.config.provider || !this.config.model)
				? "unconfigured"
				: "paused";
		this.publishActivity();
		let choice: Awaited<ReturnType<QualityUI["failure"]>>;
		try {
			choice = await this.ports.ui.failure(ctx, response.reason, this.signal(ctx));
		} finally {
			if (this.valid(ctx, generation)) this.activityOverride = undefined;
		}
		if (!this.valid(ctx, generation) || this.signal(ctx).aborted) return;
		if (choice === "waive") {
			if (!this.checkFresh(ctx) || revision(this.state!) !== expected) {
				this.pause(ctx, "Code changed during the waiver decision; retry review");
				return;
			}
			this.state!.phase = "closed";
			this.state!.resolution = "waived";
			this.persist();
			return this.result("Quality check explicitly waived by the user; not model-approved.", false);
		}
		if (choice === "model" && (await this.selectModel(ctx))) {
			this.state!.phase = "captured";
			this.persist();
			return this.result("Reviewer configured. Pending code will be reviewed before completion.", true, {
				outcome: "retrying",
			});
		}
		if (choice === "retry") {
			this.state!.phase = "captured";
			this.persist();
			return this.result("User requested another quality review attempt before continuing.", true, {
				outcome: "retrying",
			});
		}
		this.pause(ctx, response.reason);
		return;
	}
	private async resolveCoveragePause(
		ctx: ExtensionContext,
		error: CoverageError,
	): Promise<BoundaryResult | undefined> {
		const generation = this.generation;
		const choice = await this.ports.ui.coverage(
			ctx,
			error.path,
			error.message,
			this.modelKey(),
			this.signal(ctx),
		);
		if (!this.valid(ctx, generation) || this.signal(ctx).aborted) return;
		if (choice === "authorize" && ["sensitive", "external"].includes(error.kind)) {
			if (!this.state!.authorized.includes(error.path)) this.state!.authorized.push(error.path);
			this.state!.phase = "captured";
			this.persist();
			return this.result(
				"User authorized this file for the configured quality reviewer. Complete its pending review before continuing.",
				true,
				{ outcome: "retrying" },
			);
		}
		if (choice === "waive") {
			if (error.kind === "size" && !this.state!.files.some((file) => file.path === error.path)) {
				this.state!.phase = "closed";
				this.state!.resolution = "waived";
			} else {
				this.state!.files = this.state!.files.filter((file) => file.path !== error.path);
				this.state!.pendingPaths = this.state!.pendingPaths.filter((path) => path !== error.path);
				this.state!.verdict = undefined;
				this.state!.approvedTargets = undefined;
				this.state!.phase = "captured";
			}
			this.pi.appendEntry("code-quality:waiver", { path: error.path, reason: error.message });
			this.persist();
			return this.result(
				`Quality coverage explicitly waived for ${error.path}; any remaining files still require approval.`,
				this.state!.phase !== "closed",
				{ outcome: "waived" },
			);
		}
		this.pause(ctx, error.message);
		return;
	}
	async respond(
		args: {
			action: "disagree" | "request_scope";
			caseId: string;
			revision: string;
			rationale: string;
			paths?: string[];
		},
		ctx: ExtensionContext,
	): Promise<string> {
		const state = this.state;
		if (!state || state.phase === "closed" || args.caseId !== state.id || args.revision !== revision(state))
			throw new Error("No matching current quality case");
		if (!this.checkFresh(ctx))
			throw new Error("Quality snapshot changed; obtain a fresh review before responding");
		if (args.action === "disagree") {
			if (state.phase !== "correcting" || state.pendingPaths.length) {
				throw new Error("Wait for the current review before submitting a disagreement");
			}
			if (!args.rationale.trim() || args.rationale.length > 2000) {
				throw new Error("Disagreement must contain 1–2000 characters");
			}
			requestReconsideration(state, args.rationale);
			this.persist();
			return "Disagreement recorded for the reviewer. It will be reconsidered at this batch boundary; operator arbitration waits until five unresolved rounds.";
		}
		const paths = (args.paths ?? []).map((path) => canonicalPath(resolve(ctx.cwd, path)));
		if (!paths.length) throw new Error("Provide helper/test paths for scope expansion");
		const generation = this.generation;
		const confirmed = await ctx.ui.confirm(
			"Expand quality correction scope?",
			`${args.rationale}\n${paths.join("\n")}`,
			{ signal: this.signal(ctx) },
		);
		if (!this.valid(ctx, generation) || this.signal(ctx).aborted || !confirmed)
			return "Scope expansion not approved";
		for (const path of paths) if (!state.scope.includes(path)) state.scope.push(path);
		this.persist();
		return "User approved these paths for this correction case; ordinary permissions still apply.";
	}
	async selectModel(ctx: ExtensionContext, requested = ""): Promise<boolean> {
		const generation = this.generation;
		const models = ctx.modelRegistry.getAvailable();
		const choice =
			requested ||
			(await ctx.ui.select(
				"Quality reviewer model",
				models.map((model) => `${model.provider}/${model.id}`),
				{ signal: this.signal(ctx) },
			));
		if (!this.valid(ctx, generation) || this.signal(ctx).aborted) return false;
		const selected = models.find((model) => `${model.provider}/${model.id}` === choice);
		if (!selected) return false;
		this.config = saveConfig(this.agentDir, { provider: selected.provider, model: selected.id });
		this.configError = undefined;
		if (this.state && this.state.phase !== "closed") {
			this.state.authorized = [];
			this.state.providerKey = this.modelKey();
			this.state.phase = "captured";
			this.persist();
		}
		this.status(ctx);
		return true;
	}
	async command(action: string, ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Quality gate inactive outside TUI", "info");
			return;
		}
		const loaded = loadConfig(this.agentDir);
		this.config = loaded.config;
		this.configError = loaded.error;
		if (!action || action === "status") {
			ctx.ui.notify(this.summary(), "info");
			return;
		}
		if (action === "on" || action === "off") {
			if (
				action === "off" &&
				this.pending &&
				!(await ctx.ui.confirm(
					"Disable pending quality gate?",
					"This explicitly waives the unresolved case.",
				))
			)
				return;
			this.config = saveConfig(this.agentDir, { enabled: action === "on" });
			if (action === "off" && this.state) {
				this.state.phase = "closed";
				this.state.resolution = "waived";
				this.persist();
			}
			if (action === "off") this.blockedReason = undefined;
			this.status(ctx);
			return;
		}
		if (!["retry", "resolve"].includes(action)) {
			ctx.ui.notify("Usage: /quality [status|on|off|retry|resolve]", "warning");
			return;
		}
		if (this.blockedReason) {
			if (!(await ctx.ui.confirm("Waive unrecoverable quality state?", this.blockedReason))) return;
			this.blockedReason = undefined;
			this.state = newCase(this.cwd, this.modelKey());
			this.state.phase = "closed";
			this.state.resolution = "waived";
			this.persist();
			this.status(ctx);
			return;
		}
		if (!this.state || this.state.phase === "closed") {
			ctx.ui.notify("No pending quality case", "info");
			return;
		}
		this.state.phase = action === "resolve" && this.state.verdict?.edits.length ? "human" : "captured";
		this.persist();
		this.pi.sendMessage(
			{
				customType: "code-quality:feedback",
				content: `User requested ${action}. ${this.summary()}`,
				display: true,
				details: {
					outcome: this.state.phase === "human" ? "awaiting_user" : "retrying",
				} satisfies QualityFeedbackDetails,
			},
			{ triggerTurn: true },
		);
	}
}
