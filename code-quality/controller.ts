import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { BoundaryResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, saveConfig, type QualityConfig } from "./config.js";
import { planReviewBatch, canonicalPath, CoverageError, readSnapshot } from "./capture.js";
import {
	newCase,
	proposalApplied,
	recordVerdict,
	recordLspRejection,
	recordDryRejection,
	requestReconsideration,
	resolveCase,
	revision,
	type QualityCase,
} from "./case.js";
import { exclusionRule } from "./exclusions.js";
import { applyExactEdits, digest, type ValidatedVerdict } from "./proposal.js";
import { POLICY, review, type ReviewResult } from "./reviewer.js";
import type { LspManager } from "./lsp-manager.js";
import { diagnosticLabel } from "./lsp-diagnostics.js";
import type { DryGate, DryCheckResult } from "./dry-check.js";
import { DRY_POLICY } from "./dry-reviewer.js";
import { CaseStore, countRejectedReviews, latestReference, STATE_ENTRY } from "./state.js";
import type {
	QualityActivityPhase,
	QualityActivityPublisher,
	QualityActivityStatus,
	QualityDecisionKind,
} from "./activity.js";
import {
	QUALITY_CHECK_ENTRY,
	QUALITY_CHECK_UPDATE_ENTRY,
	qualityCheckLabel,
	type QualityCheckData,
	type QualityCheckSource,
	type QualityCheckOutcome,
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
	lsp?: Pick<LspManager, "check" | "revision" | "configRevision"> &
		Partial<Pick<LspManager, "restart">> & {
			refreshWorkspace?(signal: AbortSignal): Promise<void>;
		};
	createLspManager?: (changed: () => void) => LspManager;
	createDryManager?: (changed: () => void) => import("./dry-sandbox-manager.js").SandboxDryManager;
	dry?: DryGate;
	filesystem?: {
		canonical(path: string, signal?: AbortSignal): Promise<string>;
		snapshot(
			path: string,
			config: QualityConfig,
			authorized: boolean,
			signal?: AbortSignal,
		): Promise<string | null>;
	};
}
interface MutationPreparation {
	result: { block: true; reason: string } | undefined;
	path?: string;
	phase?: QualityActivityPhase;
}

const PROTOCOL =
	"Quality review is enforced after edit/write batches in TUI mode. Resolve needs_work before unrelated implementation. Apply corrections using ordinary file tools. To disagree call quality_response(disagree) with the current case/revision and your rationale; the reviewer will reconsider it. Corrections and disagreements share five response-and-review rounds after the initial rejection. Resolve the disagreement with the reviewer before reaching out to the operator; automatic arbitration occurs only after those rounds remain unresolved. Do not ask the operator to settle readability feedback early. The gate automatically waives oversized files; these waivers are not model approvals. The user must authorize all other waivers. Corrections may edit additional files directly; ordinary permissions and quality checks still apply. Do not evade the gate through bash, subagents, configuration changes, or custom file tools. User-approved proposals must be applied exactly before continuing. Readability approval covers style, not correctness. Configured LSP diagnostics of every severity enter this same correction flow before readability review. LSP disagreements rerun diagnostics; only the operator can waive them.";

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
	private checkCount = 0;
	private rejectionCount = 0;
	private activeCheck?: QualityCheckData;
	private stageStartedMonotonic?: number;
	private stageTimer?: ReturnType<typeof setInterval>;
	private readonly checks = new Map<string, QualityCheckData>();
	private readonly reviewToolPaths = new Map<string, string>();
	private readonly activityCalls = new Map<
		string,
		{ path?: string; phase?: QualityActivityPhase; blocked: boolean }
	>();
	constructor(
		readonly pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">,
		readonly agentDir: string,
		readonly ports: RuntimePorts,
	) {}

	checkDisplay(checkId: string): QualityCheckData | undefined {
		const check = this.checks.get(checkId);
		if (!check || check !== this.activeCheck || this.stageStartedMonotonic === undefined) {
			return check;
		}
		return {
			...check,
			stages: check.stages.map((stage) =>
				stage.outcome ? stage : { ...stage, elapsedMs: performance.now() - this.stageStartedMonotonic! },
			),
		};
	}
	private stopStageTimer(): void {
		clearInterval(this.stageTimer);
		this.stageTimer = undefined;
		this.stageStartedMonotonic = undefined;
	}
	private ensureCheckStageStarted(ctx: ExtensionContext, source: QualityCheckSource): void {
		const previous = this.activeCheck;
		if (previous?.stages.some((stage) => stage.source === source)) {
			return;
		}
		const check: QualityCheckData = {
			checkId: previous?.checkId ?? randomUUID(),
			caseId: this.state!.id,
			stages: [...(previous?.stages ?? []), { source, startedAtMs: Date.now() }],
		};
		this.activeCheck = check;
		this.stageStartedMonotonic = performance.now();
		clearInterval(this.stageTimer);
		this.stageTimer = setInterval(() => {
			const liveStage = this.checkDisplay(check.checkId)?.stages.at(-1);
			if (liveStage && !liveStage.outcome) {
				ctx.ui.setStatus("code-quality", qualityCheckLabel(liveStage));
			}
		}, 250);
		this.stageTimer.unref();
		this.ports.activity?.updateStage?.(source);
		this.checks.set(check.checkId, check);
		if (!previous) {
			this.checkCount += 1;
		}
		this.pi.appendEntry(previous ? QUALITY_CHECK_UPDATE_ENTRY : QUALITY_CHECK_ENTRY, check);
		this.publishActivity();
		ctx.ui.setStatus("code-quality", qualityCheckLabel({ source }));
	}
	private finishCurrentCheckStage(ctx: ExtensionContext, outcome: QualityCheckOutcome): void {
		const active = this.activeCheck;
		const currentStage = active?.stages.at(-1);
		if (!active || !currentStage || currentStage.outcome) {
			return;
		}
		const elapsedMs =
			this.stageStartedMonotonic === undefined ? undefined : performance.now() - this.stageStartedMonotonic;
		const completed = { ...currentStage, outcome, elapsedMs };
		this.stopStageTimer();
		const check = { ...active, stages: [...active.stages.slice(0, -1), completed] };
		this.activeCheck = check;
		this.checks.set(check.checkId, check);
		this.pi.appendEntry(QUALITY_CHECK_UPDATE_ENTRY, check);
		this.ports.activity?.updateStage?.(undefined);
		ctx.ui.setStatus("code-quality", qualityCheckLabel(completed));
	}
	private restoreChecks(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>): void {
		this.activeCheck = undefined;
		this.checks.clear();
		for (const entry of branch) {
			if (
				entry.type !== "custom" ||
				![QUALITY_CHECK_ENTRY, QUALITY_CHECK_UPDATE_ENTRY].includes(entry.customType)
			) {
				continue;
			}
			const data = entry.data as Partial<QualityCheckData> | undefined;
			if (typeof data?.checkId !== "string" || !Array.isArray(data.stages)) {
				continue;
			}
			this.checks.set(data.checkId, {
				checkId: data.checkId,
				caseId: data.caseId ?? "",
				stages: data.stages.map((stage) => ({ ...stage, outcome: stage.outcome ?? "interrupted" })),
			});
		}
	}

	private async awaitDecision<T>(
		ctx: ExtensionContext,
		kind: QualityDecisionKind,
		decide: () => Promise<T>,
	): Promise<T> {
		const finish = ctx.mode === "tui" ? this.ports.activity?.requestDecision(kind) : undefined;
		try {
			return await decide();
		} finally {
			finish?.();
		}
	}
	private modelKey(): string {
		return this.config.provider && this.config.model
			? `${this.config.provider}/${this.config.model}`
			: "unconfigured";
	}
	get policy(): string {
		return `${POLICY}\n\n${DRY_POLICY}\n\n${PROTOCOL}`;
	}
	get pending(): boolean {
		return Boolean(this.blockedReason || (this.state && this.state.phase !== "closed"));
	}
	waiveLsp(): void {
		if (this.state && this.state.phase !== "closed") {
			this.state.lspWaived = true;
			this.state.lsp = undefined;
			this.state.lspCapturePaths = undefined;
			this.state.lspUnavailable = undefined;
			if (this.state.phase !== "applying") {
				this.state.phase = "captured";
			}
			this.persist();
		}
	}
	waiveDry(): void {
		if (this.state && this.state.phase !== "closed") {
			this.state.dryWaived = true;
			this.state.dry = undefined;
			this.state.dryRequiredPaths = [];
			this.state.dryUnavailable = undefined;
			this.state.phase = "captured";
			this.pi.appendEntry("code-quality:waiver", {
				caseId: this.state.id,
				source: "dry",
				reason: "Operator disabled pending DRY",
			});
			this.persist();
		}
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
		if (this.activeCheck?.stages.some((stage) => !stage.outcome)) {
			return "checking";
		}
		const state = this.state;
		if (state?.phase === "reviewing") return "checking";
		if (state?.phase === "human") return "awaiting_user";
		if (state?.phase === "correcting") return "needs_work";
		if (state?.phase === "applying") return "applying";
		if (state?.phase === "paused") return "paused";
		if (state?.phase === "closed") {
			if (state.sizeWaivers?.length) {
				return "waived";
			}
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
		this.ports.activity.updateHeader(status, this.modelKey(), {
			checkCount: this.checkCount,
			rejectionCount: this.rejectionCount,
		});
		const batchPhase =
			state?.phase === "closed" && state.resolution === "model_approved" ? "approved" : phase;
		this.ports.activity.update({ ...status, phase: batchPhase });
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
	async start(ctx: ExtensionContext): Promise<void> {
		this.dispose();
		this.lifetime = new AbortController();
		const generation = this.generation;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.activityContext = ctx;
		this.activityOverride = undefined;
		this.reviewAttempt = undefined;
		const branch = ctx.sessionManager.getBranch();
		this.restoreChecks(branch);
		this.checkCount = branch.filter(
			(entry) => entry.type === "custom" && entry.customType === QUALITY_CHECK_ENTRY,
		).length;
		this.rejectionCount = countRejectedReviews(branch);
		this.activityCalls.clear();
		this.reviewToolPaths.clear();
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
				await this.checkFresh(ctx);
			}
		} catch (error) {
			if (!this.valid(ctx, generation) || this.signal(ctx).aborted) {
				return;
			}
			this.blockedReason = `Quality recovery requires a user decision: ${String(error)}`;
		}
		if (!this.valid(ctx, generation) || this.signal(ctx).aborted) {
			return;
		}
		this.status(ctx, this.configError ? "invalid configuration" : undefined);
	}
	dispose(): void {
		this.stopStageTimer();
		this.generation++;
		this.lifetime.abort();
		this.operation = false;
		this.activityContext = undefined;
		this.activityCalls.clear();
		this.reviewToolPaths.clear();
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
	private async snapshot(path: string, callerSignal?: AbortSignal): Promise<string | null> {
		const generation = this.generation;
		const state = this.state;
		const store = this.store;
		const signal = callerSignal
			? AbortSignal.any([this.lifetime.signal, callerSignal])
			: this.lifetime.signal;
		signal.throwIfAborted();
		const value = this.ports.filesystem
			? await this.ports.filesystem.snapshot(path, this.config, this.authorized(path), signal)
			: readSnapshot(path, this.config, this.authorized(path));
		if (signal.aborted || generation !== this.generation || state !== this.state || store !== this.store) {
			throw new Error("Quality snapshot belongs to a retired case");
		}
		return value;
	}
	private autoWaiveSize(path: string, reason: string, persist = true): void {
		const state = this.state!;
		state.sizeWaivers ??= [];
		if (!state.sizeWaivers.some((waiver) => waiver.path === path)) {
			state.sizeWaivers.push({ path, reason });
			this.pi.appendEntry("code-quality:waiver", {
				caseId: state.id,
				path,
				reason,
				automatic: true,
				reviewed: false,
			});
			this.pi.sendMessage(
				{
					customType: "code-quality:feedback",
					content: `Quality automatically waived for oversized file: ${path} (${reason}). Not model-approved.`,
					display: true,
					details: { outcome: "waived" } satisfies QualityFeedbackDetails,
				},
				{ triggerTurn: false, deliverAs: "nextTurn" },
			);
		}
		if (this.config.dryEnabled && !state.dryWaived && !state.dryRequiredPaths?.includes(path)) {
			state.dryRequiredPaths = [...(state.dryRequiredPaths ?? []), path];
		}
		const trackedFile = state.files.some((file) => file.path === path);
		const unresolvedLsp =
			Boolean(state.lsp?.findings.some((finding) => finding.file === path)) ||
			Boolean(state.lspRequired && (!state.lsp || state.lspUnavailable));
		if (trackedFile && unresolvedLsp && !state.lspWaived) {
			state.lspCapturePaths = [...new Set([...(state.lspCapturePaths ?? []), path])];
		}
		state.files = state.files.filter((file) => file.path !== path);
		state.pendingPaths = state.pendingPaths.filter((pendingPath) => pendingPath !== path);
		if (state.lsp && !state.lsp.findings.length && !state.lspUnavailable && !state.lspCapturePaths?.length) {
			const coveredPaths = state.lsp.paths ?? [path];
			if (!state.files.some((file) => coveredPaths.includes(file.path))) {
				state.lsp = undefined;
				state.lspRequired = false;
			}
		}
		if (state.phase === "applying") {
			delete state.approvedTargets?.[path];
		} else {
			state.verdict = undefined;
			state.approvedTargets = undefined;
			state.phase = "captured";
		}
		this.ignoredPaths.add(path);
		for (const [id, call] of this.activityCalls) {
			if (call.path === path) {
				call.phase = "waived";
				this.ports.activity?.finishTool(id, "waived");
			}
		}
		for (const [id, reviewedPath] of this.reviewToolPaths) {
			if (reviewedPath === path) {
				this.ports.activity?.finishTool(id, "waived");
				this.reviewToolPaths.delete(id);
			}
		}
		if (persist) {
			this.persist();
		}
	}
	private closeSizeWaivedCase(ctx: ExtensionContext): BoundaryResult {
		this.state!.phase = "closed";
		this.state!.resolution = "waived";
		this.persist();
		this.status(ctx);
		return this.result(
			"Quality automatically waived for oversized files; no model approval. No changed files remain eligible for readability review.",
			false,
			{ outcome: "waived" },
		);
	}
	private async checkFresh(ctx: ExtensionContext): Promise<boolean> {
		if (!this.state || this.state.phase === "closed") return true;
		const state = this.state;
		const generation = this.generation;
		for (const path of state.lspCapturePaths ?? []) {
			let restored: string | null;
			try {
				restored = await this.snapshot(path, this.signal(ctx));
			} catch (error) {
				if (error instanceof CoverageError && error.kind === "size") {
					continue;
				}
				throw error;
			}
			state.files.push({ path, before: null, after: restored });
			state.lspCapturePaths = state.lspCapturePaths?.filter((capturePath) => capturePath !== path);
			state.sizeWaivers = state.sizeWaivers?.filter((waiver) => waiver.path !== path);
			this.ignoredPaths.delete(path);
			if (state.approvedTargets) {
				state.phase = "applying";
			} else {
				state.phase = "captured";
			}
			state.correctionPending = false;
			state.reconsiderationPending = false;
			state.objection = undefined;
			this.persist();
			return false;
		}
		for (const file of state.files) {
			if (state.pendingPaths.includes(file.path)) continue;
			let actual: string | null;
			try {
				actual = await this.snapshot(file.path, this.signal(ctx));
			} catch (error) {
				if (!this.valid(ctx, generation) || this.state !== state || this.signal(ctx).aborted) {
					throw error;
				}
				if (error instanceof CoverageError && error.kind === "size") {
					state.correctionPending = false;
					state.reconsiderationPending = false;
					state.objection = undefined;
					this.autoWaiveSize(file.path, error.message);
					return false;
				}
				throw error;
			}
			if (!this.valid(ctx, generation) || this.state !== state || this.signal(ctx).aborted) {
				throw new Error("Quality freshness check belongs to a retired case");
			}
			if (actual !== file.after) {
				file.after = actual;
				this.state.verdict = undefined;
				this.state.dry = undefined;
				this.state.responsePass = undefined;
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
		if (toolCallId) {
			if (!this.activityCalls.size) {
				this.reviewToolPaths.clear();
			}
			this.ports.activity?.begin(toolCallId);
		}
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
		const generation = this.generation;
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
			const captureGeneration = this.generation;
			path = this.ports.filesystem
				? await this.ports.filesystem.canonical(rawPath, this.signal(ctx))
				: canonicalPath(requested);
			if (!this.valid(ctx, captureGeneration) || this.signal(ctx).aborted) {
				return blocked("Quality capture belongs to a retired session");
			}
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
			if (
				state.phase === "captured" &&
				!state.pendingPaths.length &&
				state.files.some((file) => file.before !== file.after)
			)
				return blocked("A fresh quality verdict is pending; inspect the case before editing again.");
			if (["human", "paused"].includes(state.phase))
				return blocked(`${this.summary()} Resolve with /quality resolve before editing.`);
			if (state.phase === "applying" && !Object.hasOwn(state.approvedTargets ?? {}, path)) {
				return blocked("Apply only the files in the user-approved proposal before continuing.");
			}
			if (!(await this.checkFresh(ctx)))
				return blocked("Review snapshot became stale; wait for a fresh verdict before editing.");
			if (
				state.phase === "applying" &&
				state.approvedTargets?.[path] === digest(await this.snapshot(path, this.signal(ctx)))
			)
				return blocked(
					"This file already matches the user-approved proposal. Apply only its remaining files.",
				);
			let before: string | null;
			try {
				before = await this.snapshot(path, this.signal(ctx));
			} catch (error) {
				if (!this.valid(ctx, generation) || this.state !== state || this.signal(ctx).aborted) {
					throw error;
				}
				if (error instanceof CoverageError && error.kind === "size") {
					this.autoWaiveSize(path, error.message);
					return { result: undefined, path, phase: "waived" };
				}
				if (error instanceof CoverageError && error.kind === "binary") {
					this.ignoredPaths.add(path);
					this.receipt(`Not reviewed (binary/non-UTF-8): ${path}`);
					return { result: undefined, path, phase: "not_reviewed" };
				}
				const coveragePath = path;
				const decision = await this.awaitDecision(ctx, "coverage", () =>
					this.ports.ui.coverage(ctx, coveragePath, String(error), this.modelKey(), this.signal(ctx)),
				);
				if (!this.valid(ctx, generation) || this.signal(ctx).aborted)
					return blocked("Quality decision cancelled");
				if (decision === "waive") {
					this.ignoredPaths.add(path);
					this.pi.appendEntry("code-quality:waiver", { path, reason: String(error) });
					return { result: undefined, path, phase: "not_reviewed" };
				}
				if (decision !== "authorize" || (error instanceof CoverageError && error.kind !== "sensitive")) {
					this.pause(ctx, String(error));
					return blocked("Quality review requires a coverage decision");
				}
				state.authorized.push(path);
				before = await this.snapshot(path, this.signal(ctx));
			}
			if (!this.valid(ctx, generation) || this.state !== state || this.signal(ctx).aborted) {
				return blocked("Quality capture belongs to a retired case");
			}
			if (!state.files.some((file) => file.path === path)) state.files.push({ path, before, after: before });
			if (!state.pendingPaths.includes(path)) state.pendingPaths.push(path);
			this.ignoredPaths.delete(path);
			state.sizeWaivers = state.sizeWaivers?.filter((waiver) => waiver.path !== path);
			state.lspCapturePaths = state.lspCapturePaths?.filter((capturePath) => capturePath !== path);
			this.persist();
			return { result: undefined, path };
		} catch (error) {
			if (this.signal(ctx).aborted || !this.valid(ctx, generation)) {
				return blocked("Quality capture belongs to a retired session");
			}
			if (path && error instanceof CoverageError && error.kind === "size") {
				this.autoWaiveSize(path, error.message);
				return { result: undefined, path, phase: "waived" };
			}
			this.pause(ctx, `Quality capture failed: ${String(error)}`);
			return blocked("Quality capture failed; resolve before retrying");
		}
	}
	private async reconcile(ctx: ExtensionContext): Promise<boolean> {
		const state = this.state;
		if (!state) return false;
		const generation = this.generation;
		const assertOwner = () => {
			if (!this.valid(ctx, generation) || this.state !== state || this.signal(ctx).aborted) {
				throw new Error("Quality capture belongs to a retired case");
			}
		};
		let changed = false;
		for (const path of state.pendingPaths) {
			const file = state.files.find((file) => file.path === path);
			if (!file || this.ignoredPaths.has(path)) continue;
			let after: string | null;
			try {
				after = await this.snapshot(path, this.signal(ctx));
			} catch (error) {
				assertOwner();
				if (error instanceof CoverageError && error.kind === "size") {
					changed = true;
					this.autoWaiveSize(path, error.message);
					continue;
				}
				const decision =
					error instanceof CoverageError && error.kind === "binary"
						? "waive"
						: await this.awaitDecision(ctx, "coverage", () =>
								this.ports.ui.coverage(ctx, path, String(error), this.modelKey(), this.signal(ctx)),
							);
				assertOwner();
				if (decision === "waive") {
					state.files = state.files.filter((candidate) => candidate.path !== path);
					state.verdict = undefined;
					state.approvedTargets = undefined;
					state.phase = "captured";
					this.pi.appendEntry("code-quality:waiver", { path, reason: String(error), reviewed: false });
					this.receipt(`Quality not reviewed: ${path} (${String(error)})`);
					continue;
				}
				if (decision !== "authorize" || !(error instanceof CoverageError) || error.kind !== "sensitive")
					throw new Error(String(error));
				state.authorized.push(path);
				after = await this.snapshot(path, this.signal(ctx));
			}
			assertOwner();
			changed ||= after !== file.after;
			file.after = after;
		}
		assertOwner();
		state.pendingPaths = [];
		this.captureChanged ||= changed;
		if (changed && state.reviewed) {
			state.correctionPending = true;
			state.responsePass = undefined;
			state.reconsiderationPending = false;
			state.objection = undefined;
		}
		this.persist();
		return changed;
	}
	private feedback(): string {
		const state = this.state!;
		if (state.activeRejectionSource === "dry" && state.dry?.verdict?.findings.length) {
			return `${this.summary()}\nDRY quality findings (no exact patch required):\n${JSON.stringify(state.dry.verdict)}\nResolve shared ownership with a bounded correction or quality_response(disagree). The shared five-round budget and operator arbitration apply.`;
		}
		if (state.lsp?.findings.length)
			return `${this.summary()}\nLSP quality findings (all severities must be resolved):\n${state.lsp.findings.map(diagnosticLabel).join("\n")}\nResolve this case before unrelated work. Corrections and disagreements use the shared round budget. quality_response(disagree) reruns LSP diagnostics; only the operator can waive them.`;
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
		if (state?.resolution === "waived" || (state?.phase === "closed" && state.sizeWaivers?.length)) {
			return { outcome: "waived" };
		}
		if (state?.phase === "closed") {
			const outcome = state.resolution === "unchanged" ? "not_reviewed" : "approved";
			return { outcome };
		}
		if (state?.phase === "applying") return { outcome: "applying" };
		if (state?.activeRejectionSource === "dry" && state.dry?.verdict?.findings.length) {
			const rejectionText = state.dry.verdict.findings
				.map((finding) => {
					const findingLocation = `${finding.file}:${finding.line}`;
					const counterpartLocation = `${finding.counterpartFile}:${finding.counterpartRange.join("–")}`;
					return [
						`${findingLocation} / ${counterpartLocation}`,
						finding.duplicatedKnowledge,
						finding.sharedOwnershipRationale,
						`Correction: ${finding.correctionDirection}`,
					].join("\n");
				})
				.join("\n\n");
			return { outcome: "rejected", rejection: state.attempts + 1, rejectionText };
		}
		if (state?.verdict?.verdict === "needs_work" || state?.lsp?.findings.length) {
			const rejectionText = state.lsp?.findings.length
				? state.lsp.findings.map(diagnosticLabel).join("\n")
				: [
						state.verdict!.rationale,
						...state.verdict!.findings.map(
							(finding) => `${finding.file}:${finding.line} [${finding.rule}] ${finding.rationale}`,
						),
					].join("\n\n");
			return { outcome: "rejected", rejection: state.attempts + 1, rejectionText };
		}
		return { outcome: "retrying" };
	}
	private finishActivityCollection(): void {
		for (const [id, call] of this.activityCalls) {
			if (call.phase) continue;
			const file = this.state?.files.find((file) => file.path === call.path);
			if (!file) this.ports.activity?.finishTool(id, "not_reviewed");
			else if (file.before === file.after) this.ports.activity?.finishTool(id, "unchanged");
			else if (call.path) {
				this.reviewToolPaths.set(id, call.path);
			}
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
		const piSessionId = ctx.sessionManager.getSessionId();
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
			await this.checkFresh(ctx);
			if (state.phase === "paused") {
				this.pause(ctx, state.reason ?? "Quality decision pending");
				return;
			}
			if (state.phase === "applying") {
				if (proposalApplied(state)) {
					const lspOutcome = await this.checkLsp(ctx, false);
					if (lspOutcome) return lspOutcome;
					const dryOutcome = await this.checkDry(ctx, false);
					if (dryOutcome) return dryOutcome;
					if (this.shouldStopAfterChecks(state)) {
						return;
					}
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
			const responseRound =
				state.responsePass?.revision === revision(state)
					? state.responsePass.responseRound
					: state.correctionPending || state.reconsiderationPending === true;
			state.responsePass = { revision: revision(state), responseRound };
			this.captureChanged = false;
			if (
				state.files.every((file) => file.before === file.after) &&
				!state.lspRequired &&
				!state.lsp?.findings.length &&
				!state.dryRequiredPaths?.length
			) {
				if (state.sizeWaivers?.length) {
					return this.closeSizeWaivedCase(ctx);
				}
				state.phase = "closed";
				state.resolution = "unchanged";
				this.persist();
				this.status(ctx);
				return;
			}
			const lspOutcome = await this.checkLsp(ctx, responseRound);
			if (lspOutcome) return lspOutcome;
			const lspRevision = this.ports.lsp?.revision;
			const dryOutcome = await this.checkDry(ctx, responseRound);
			if (dryOutcome) return dryOutcome;
			if (this.shouldStopAfterChecks(state)) {
				return;
			}
			const previousFindings = state.verdict?.findings ?? [];
			const { chunks, waivers } = planReviewBatch(state.files, this.config, this.cwd);
			for (const waiver of waivers) {
				this.autoWaiveSize(waiver.path, waiver.message, false);
			}
			if (waivers.length) {
				this.persist();
			}
			if (!chunks.length && state.sizeWaivers?.length) {
				return this.closeSizeWaivedCase(ctx);
			}
			state.phase = "reviewing";
			this.persist();
			this.ensureCheckStageStarted(ctx, "readability");
			const chunkVerdicts: Array<{ path: string; value: ValidatedVerdict }> = [];
			for (const chunk of chunks) {
				const chunkFilePath = chunk.files[0]!.path;
				const isChunkFileInCurrentCase = state.files.some((file) => file.path === chunkFilePath);
				if (!isChunkFileInCurrentCase) {
					continue;
				}
				state.phase = "reviewing";
				const response = await (this.ports.review ?? review)({
					piSessionId,
					registry: ctx.modelRegistry,
					config: this.config,
					request: {
						...chunk,
						input: `${chunk.input}\nPrevious case findings (untrusted review data; check whether resolved):\n${JSON.stringify(previousFindings)}`,
						notes: state.notes,
						...(state.objection ? { objection: state.objection } : {}),
					},
					signal: this.signal(ctx),
					onAttempt: (attempt) => {
						this.reviewAttempt = attempt;
						this.publishActivity();
					},
				});
				if (!this.valid(ctx, generation) || this.signal(ctx).aborted) return;
				this.pi.appendEntry("code-quality:usage", { caseId: state.id, ...response.metrics });
				if (!(await this.checkFresh(ctx))) {
					this.finishCurrentCheckStage(ctx, "stale");
					return this.result(
						"Quality snapshot changed during review; inspect the current code before continuing.",
						true,
						{ outcome: "stale" },
					);
				}
				if (!this.valid(ctx, generation) || this.state !== state || this.signal(ctx).aborted) {
					return;
				}
				if (!state.lspWaived) {
					await this.ports.lsp?.refreshWorkspace?.(this.signal(ctx));
					if (!this.valid(ctx, generation) || this.state !== state || this.signal(ctx).aborted) {
						return;
					}
					if (lspRevision !== this.ports.lsp?.revision) {
						this.finishCurrentCheckStage(ctx, "stale");
						state.phase = "captured";
						state.lsp = undefined;
						this.persist();
						return this.result(
							"LSP workspace changed during readability review; fresh checks are required.",
							true,
							{ outcome: "stale" },
						);
					}
				}
				if (response.kind === "oversized") {
					this.autoWaiveSize(chunkFilePath, response.reason);
					continue;
				}
				if (response.kind !== "verdict") {
					this.finishCurrentCheckStage(ctx, response.kind === "cancelled" ? "interrupted" : "failed");
					return await this.reviewFailure(ctx, response);
				}
				chunkVerdicts.push({ path: chunkFilePath, value: response.value });
			}
			if (!state.files.length && state.sizeWaivers?.length) {
				this.finishCurrentCheckStage(ctx, "failed");
				return this.closeSizeWaivedCase(ctx);
			}
			const eligiblePaths = new Set(state.files.map((file) => file.path));
			const eligibleVerdicts = chunkVerdicts.filter((chunk) => eligiblePaths.has(chunk.path));
			const findings = eligibleVerdicts.flatMap((chunk) => chunk.value.findings);
			const edits = eligibleVerdicts.flatMap((chunk) => chunk.value.edits);
			const reasons = eligibleVerdicts.map((chunk) => chunk.value.rationale);
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
			state.phase = "reviewing";
			this.persist();
			recordVerdict(state, verdict, responseRound);
			this.finishCurrentCheckStage(ctx, verdict.verdict === "approved" ? "passed" : "failed");
			if (verdict.verdict === "needs_work") this.rejectionCount += 1;
			this.persist();
			this.status(ctx);
			if (verdict.verdict === "needs_work" && state.attempts >= state.limit) return await this.arbitrate(ctx);
			const waiverDescription = state.sizeWaivers?.length
				? ` ${state.sizeWaivers.length} oversized file(s) automatically waived, not model-approved.`
				: "";
			let approvalDescription = "Style only; correctness not certified.";
			let dryDescription = "";
			if (state.dryWaived) {
				dryDescription = " DRY explicitly waived, not model-approved.";
			} else if (state.dry) {
				const dryReviewStatus = state.dry.verdict ? "supplied pairs reviewed" : "no retrieved candidates";
				dryDescription = ` DRY: ${dryReviewStatus}; bounded retrieval, not exhaustive.`;
			}
			if (state.lsp)
				approvalDescription =
					"Configured LSP diagnostics clean; readability approved. Not a build/correctness certification.";
			if (state.lspWaived)
				approvalDescription =
					"Readability approved; LSP explicitly waived by the operator. Not a clean LSP verdict.";
			return this.result(
				verdict.verdict === "approved"
					? `Quality approved: ${state.files.length} file(s), snapshot ${revision(state)}. ${approvalDescription}${dryDescription}${waiverDescription}`
					: this.feedback(),
				verdict.verdict !== "approved",
			);
		} catch (error) {
			if (!this.valid(ctx, generation) || this.signal(ctx).aborted) {
				return;
			}
			if (this.valid(ctx, generation)) {
				this.finishCurrentCheckStage(ctx, this.signal(ctx).aborted ? "interrupted" : "failed");
			}
			if (error instanceof CoverageError && this.state && !this.signal(ctx).aborted) {
				if (error.kind === "size") {
					this.autoWaiveSize(error.path, error.message);
					return this.result(
						"Oversized file automatically waived; continuing review of eligible files.",
						true,
						{ outcome: "waived" },
					);
				}
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
				this.finishCurrentCheckStage(ctx, "interrupted");
				this.activeCheck = undefined;
				this.stopStageTimer();
				this.ports.activity?.finishCollection();
				this.publishActivity();
				this.operation = false;
				if (!this.pending) {
					this.reviewToolPaths.clear();
				}
			}
		}
	}
	private shouldStopAfterChecks(state: QualityCase): boolean {
		const isPaused = state.phase === "paused";
		const dryReviewNeedsWork =
			state.activeRejectionSource === "dry" && state.dry?.verdict?.verdict === "needs_work";
		return isPaused || dryReviewNeedsWork;
	}
	private async checkDry(ctx: ExtensionContext, responseRound: boolean): Promise<BoundaryResult | undefined> {
		const state = this.state!;
		if (!this.config.dryEnabled || state.dryWaived) {
			return;
		}
		const sourceFiles = state.files.filter(
			(file) => file.before !== file.after && !/\.(md|mdx|rst|txt)$/i.test(file.path),
		);
		if (!sourceFiles.length && !state.dryRequiredPaths?.length) {
			return;
		}
		const generation = this.generation;
		const expected = revision(state);
		state.phase = "reviewing";
		this.ensureCheckStageStarted(ctx, "dry");
		const missingRequiredPaths = (state.dryRequiredPaths ?? []).filter(
			(path) => !state.files.some((file) => file.path === path),
		);
		if (missingRequiredPaths.length) {
			return this.handleDryFailure(
				ctx,
				state,
				{
					kind: "unavailable",
					reason: `DRY requires recapturing size-waived source: ${missingRequiredPaths.join(", ")}`,
					metrics: { requests: 0, latencyMs: 0, usages: [] },
				},
				generation,
			);
		}
		this.persist();
		const dry = this.ports.dry;
		const checked = dry
			? await dry.check({
					files: sourceFiles,
					authorized: state.authorized,
					config: this.config,
					registry: ctx.modelRegistry,
					piSessionId: ctx.sessionManager.getSessionId(),
					revision: expected,
					notes: state.notes,
					objection: state.activeRejectionSource === "dry" ? state.objection : undefined,
					previousFindings: state.dry?.verdict?.findings,
					signal: this.signal(ctx),
					onAttempt: (attempt) => {
						this.reviewAttempt = attempt;
						this.publishActivity();
					},
				})
			: {
					kind: "unavailable" as const,
					reason:
						"DRY checking requires the managed sandbox index. Restore provisioning or explicitly waive DRY.",
					metrics: { requests: 0, latencyMs: 0, usages: [] },
				};
		if (!this.valid(ctx, generation) || this.signal(ctx).aborted) {
			return this.result("DRY check interrupted; review remains pending.", false);
		}
		this.pi.appendEntry("code-quality:usage", { caseId: state.id, source: "dry", ...checked.metrics });
		if (!(await this.checkFresh(ctx)) || revision(state) !== expected || checked.kind === "stale") {
			this.finishCurrentCheckStage(ctx, "stale");
			state.phase = "captured";
			state.dry = undefined;
			this.persist();
			return this.result("DRY source snapshot changed; fresh checks are required.", true, {
				outcome: "stale",
			});
		}
		if (checked.kind !== "checked") {
			return this.handleDryFailure(ctx, state, checked, generation);
		}
		state.dry = checked.assessment;
		state.dryUnavailable = undefined;
		state.dryRequiredPaths = [];
		const rejected = checked.assessment.verdict?.verdict === "needs_work";
		this.finishCurrentCheckStage(ctx, rejected ? "failed" : "passed");
		if (!rejected) {
			this.persist();
			return;
		}
		recordDryRejection(state, checked.assessment, responseRound);
		this.rejectionCount++;
		this.persist();
		this.status(ctx);
		if (state.attempts >= state.limit) {
			return this.arbitrate(ctx);
		}
		return this.result(this.feedback(), true);
	}
	private async handleDryFailure(
		ctx: ExtensionContext,
		state: QualityCase,
		checked: Exclude<DryCheckResult, { kind: "checked" }>,
		generation: number,
	): Promise<BoundaryResult | undefined> {
		state.dryUnavailable = checked.reason;
		this.finishCurrentCheckStage(ctx, checked.kind === "cancelled" ? "interrupted" : "failed");
		this.persist();
		const choice = await this.awaitDecision(ctx, "dry_failure", () =>
			this.ports.ui.failure(ctx, `DRY unavailable: ${checked.reason}`, this.signal(ctx)),
		);
		if (!this.valid(ctx, generation) || this.signal(ctx).aborted) {
			return;
		}
		if (!(await this.checkFresh(ctx))) {
			return this.result("Source changed during DRY recovery; retry against the current snapshot.", true, {
				outcome: "stale",
			});
		}
		if (choice === "waive") {
			state.dryWaived = true;
			state.dry = undefined;
			state.dryUnavailable = undefined;
			state.dryRequiredPaths = [];
			state.phase = "reviewing";
			this.pi.appendEntry("code-quality:waiver", { caseId: state.id, source: "dry", reason: checked.reason });
			this.persist();
			return;
		}
		if (choice === "model") {
			await this.selectModel(ctx);
		}
		if (choice === "retry" || choice === "model") {
			state.phase = "captured";
			this.persist();
			return this.result("DRY retry requested; other applicable stages remain pending.", true, {
				outcome: "retrying",
			});
		}
		this.pause(ctx, checked.reason);
		return this.result("DRY recovery paused; use Settings or /quality retry.", false, {
			outcome: "awaiting_user",
		});
	}
	private async checkLsp(ctx: ExtensionContext, responseRound: boolean): Promise<BoundaryResult | undefined> {
		const lsp = this.ports.lsp;
		const state = this.state!;
		if (state.lspWaived) return;
		if (!lsp) {
			if (state.lspRequired) {
				this.ensureCheckStageStarted(ctx, "lsp");
				this.finishCurrentCheckStage(ctx, "failed");
				this.pause(ctx, "Required LSP checking is unavailable; restore it or explicitly waive this case.");
				return this.result("Required LSP coverage is unavailable.", false, { outcome: "awaiting_user" });
			}
			return;
		}
		const generation = this.generation;
		const expected = revision(state);
		this.ensureCheckStageStarted(ctx, "lsp");
		let checked = state.lspCapturePaths?.length
			? {
					kind: "unavailable" as const,
					reason: `Outstanding LSP checks require recapturing oversized files: ${state.lspCapturePaths.join(", ")}. Restore capture eligibility or explicitly waive LSP.`,
				}
			: await lsp
					.check(state.files, this.signal(ctx), () => {
						if (this.valid(ctx, generation) && !this.signal(ctx).aborted) {
							this.ensureCheckStageStarted(ctx, "lsp");
						}
					})
					.catch((error) => ({ kind: "unavailable" as const, reason: String(error) }));
		if (!this.valid(ctx, generation) || this.signal(ctx).aborted)
			return this.result("LSP check interrupted; review remains pending.", false, { outcome: "retrying" });
		if (!checked && (state.lspRequired || state.lsp))
			checked = {
				kind: "unavailable",
				reason: "LSP coverage changed for this pending case; restore configuration or explicitly waive it.",
			};
		if (!checked) {
			this.stopStageTimer();
			const active = this.activeCheck;
			if (active) {
				const check = { ...active, stages: active.stages.slice(0, -1) };
				this.activeCheck = check;
				this.checks.set(check.checkId, check);
				this.pi.appendEntry(QUALITY_CHECK_UPDATE_ENTRY, check);
			}
			return;
		}
		this.ensureCheckStageStarted(ctx, "lsp");
		state.lspRequired = true;
		this.persist();
		if (!(await this.checkFresh(ctx)) || revision(state) !== expected || checked.kind === "stale") {
			this.finishCurrentCheckStage(ctx, "stale");
			state.phase = "captured";
			state.lsp = undefined;
			this.persist();
			return this.result("LSP snapshot changed; fresh diagnostics are required before review.", true, {
				outcome: "stale",
			});
		}
		if (checked.kind !== "checked") {
			state.lspUnavailable = checked.reason;
			this.persist();
			this.finishCurrentCheckStage(ctx, checked.kind === "cancelled" ? "interrupted" : "failed");
			const choice = await this.awaitDecision(ctx, "lsp_failure", () =>
				ctx.ui.select(
					`LSP unavailable: ${checked.reason}`,
					["Retry LSP check", "Reconfigure with /quality lsp setup", "Waive LSP for this case"],
					{ signal: this.signal(ctx) },
				),
			);
			if (!this.valid(ctx, generation) || this.signal(ctx).aborted)
				return this.result("LSP recovery interrupted.", false);
			if (!(await this.checkFresh(ctx)) || revision(state) !== expected) {
				state.phase = "captured";
				this.persist();
				return this.result("Code changed during LSP recovery; review the new snapshot.", true, {
					outcome: "stale",
				});
			}
			if (choice === "Waive LSP for this case") {
				state.lspWaived = true;
				state.lsp = undefined;
				state.lspCapturePaths = undefined;
				state.lspUnavailable = undefined;
				this.persist();
				return;
			}
			if (choice === "Retry LSP check") {
				await lsp.restart?.(undefined, this.signal(ctx));
				if (!this.valid(ctx, generation) || this.signal(ctx).aborted)
					return this.result("LSP restart interrupted.", false);
				state.phase = "captured";
				this.persist();
				return this.result("Retrying configured LSP checks.", true, { outcome: "retrying" });
			}
			this.pause(ctx, checked.reason);
			return this.result("LSP recovery paused. Use /quality lsp setup or /quality retry.", false, {
				outcome: "awaiting_user",
			});
		}
		const assessment = {
			paths: [
				...new Set([...Object.keys(checked.hashes), ...checked.findings.map((finding) => finding.file)]),
			],
			findings: checked.findings,
			revision: expected,
			configuration: lsp.configRevision,
			workspaceRevision: lsp.revision,
			generation: checked.generation,
		};
		state.lsp = assessment;
		state.lspUnavailable = undefined;
		this.finishCurrentCheckStage(ctx, checked.findings.length ? "failed" : "passed");
		if (!checked.findings.length) {
			this.persist();
			return;
		}
		state.approvedTargets = undefined;
		state.phase = "reviewing";
		this.persist();
		recordLspRejection(state, assessment, responseRound);
		this.rejectionCount++;
		this.persist();
		this.status(ctx);
		if (state.attempts >= state.limit) return this.arbitrate(ctx);
		return this.result(this.feedback(), true);
	}

	private async arbitrate(ctx: ExtensionContext): Promise<BoundaryResult | undefined> {
		const state = this.state!;
		state.phase = "human";
		this.persist();
		this.status(ctx);
		const expected = revision(state);
		const generation = this.generation;
		if (!state.verdict?.edits.length && !state.lsp?.findings.length && !state.dry?.verdict?.findings.length) {
			this.pause(ctx, "No current findings to review; use /quality retry");
			return;
		}
		const choice = await this.awaitDecision(ctx, "arbitration", () =>
			this.ports.ui.arbitrate(ctx, state, this.signal(ctx)),
		);
		if (!this.valid(ctx, generation) || this.signal(ctx).aborted) return;
		if (!choice) {
			this.pause(ctx, "Quality arbitration cancelled; /quality resolve to reopen");
			return;
		}
		const sourceIsFresh = await this.checkFresh(ctx);
		if (!state.lspWaived) {
			await this.ports.lsp?.refreshWorkspace?.(this.signal(ctx));
		}
		if (!this.valid(ctx, generation) || this.state !== state || this.signal(ctx).aborted) {
			return;
		}
		const lspWorkspaceChanged =
			state.lsp !== undefined &&
			this.ports.lsp !== undefined &&
			state.lsp.workspaceRevision !== this.ports.lsp.revision;
		if (!sourceIsFresh || revision(state) !== expected || lspWorkspaceChanged) {
			this.pause(ctx, "Code or LSP workspace changed while deciding; review again");
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
				? `Quality: user approved the current code for this case.${state.lsp?.findings.length ? " Outstanding LSP diagnostics accepted; readability may not have run. This is not a clean diagnostic verdict." : ""}`
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
			choice = await this.awaitDecision(ctx, "failure", () =>
				this.ports.ui.failure(ctx, response.reason, this.signal(ctx)),
			);
		} finally {
			if (this.valid(ctx, generation)) this.activityOverride = undefined;
		}
		if (!this.valid(ctx, generation) || this.signal(ctx).aborted) return;
		if (choice === "waive") {
			if (!(await this.checkFresh(ctx)) || revision(this.state!) !== expected) {
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
		const choice = await this.awaitDecision(ctx, "coverage", () =>
			this.ports.ui.coverage(ctx, error.path, error.message, this.modelKey(), this.signal(ctx)),
		);
		if (!this.valid(ctx, generation) || this.signal(ctx).aborted) return;
		if (choice === "authorize" && error.kind === "sensitive") {
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
			this.state!.files = this.state!.files.filter((file) => file.path !== error.path);
			this.state!.pendingPaths = this.state!.pendingPaths.filter((path) => path !== error.path);
			this.state!.verdict = undefined;
			this.state!.approvedTargets = undefined;
			this.state!.phase = "captured";
			this.pi.appendEntry("code-quality:waiver", { path: error.path, reason: error.message });
			this.persist();
			return this.result(
				`Quality coverage explicitly waived for ${error.path}; any remaining files still require approval.`,
				true,
				{ outcome: "waived" },
			);
		}
		this.pause(ctx, error.message);
		return;
	}
	async respond(
		args: {
			action: "disagree";
			caseId: string;
			revision: string;
			rationale: string;
		},
		ctx: ExtensionContext,
	): Promise<string> {
		const state = this.state;
		if (!state || state.phase === "closed" || args.caseId !== state.id || args.revision !== revision(state)) {
			throw new Error("No matching current quality case");
		}
		if (!(await this.checkFresh(ctx))) {
			throw new Error("Quality snapshot changed; obtain a fresh review before responding");
		}
		if (state.phase !== "correcting" || state.pendingPaths.length) {
			throw new Error("Wait for the current review before submitting a disagreement");
		}
		if (!args.rationale.trim() || args.rationale.length > 2000) {
			throw new Error("Disagreement must contain 1–2000 characters");
		}
		requestReconsideration(state, args.rationale);
		this.persist();
		return state.lsp?.findings.length
			? `Disagreement queued for fresh LSP diagnostics under the shared round budget:\n\n${args.rationale}`
			: `Disagreement queued for reviewer reconsideration:\n\n${args.rationale}`;
	}
	async selectModel(ctx: ExtensionContext, requested = ""): Promise<boolean> {
		const generation = this.generation;
		const models = ctx.modelRegistry.getAvailable();
		const choice =
			requested ||
			(await this.awaitDecision(ctx, "model", () =>
				ctx.ui.select(
					"Quality reviewer model",
					models.map((model) => `${model.provider}/${model.id}`),
					{ signal: this.signal(ctx) },
				),
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
	async applySettings(
		ctx: ExtensionContext,
		value: unknown,
		interactionSignal?: AbortSignal,
		expectedConfigRevision?: string,
	): Promise<void> {
		const generation = this.generation;
		const state = this.state;
		const signal = AbortSignal.any([this.signal(ctx), ...(interactionSignal ? [interactionSignal] : [])]);
		const assertOwner = () => {
			signal.throwIfAborted();
			if (!this.valid(ctx, generation) || this.state !== state || ctx.isIdle?.() === false) {
				throw new Error("Quality settings belong to a retired interaction");
			}
		};
		const { parseConfig } = await import("./config.js");
		assertOwner();
		const next = parseConfig(value);
		if (!next.dryEnabled && this.config.dryEnabled && this.pending && !state?.dryWaived) {
			throw new Error("Resolve or explicitly waive pending DRY before disabling it in Settings");
		}
		if (!next.enabled && this.pending) {
			throw new Error("Resolve the pending quality case before disabling the gate in Settings");
		}
		assertOwner();
		const modelChanged = next.provider !== this.config.provider || next.model !== this.config.model;
		this.config = saveConfig(this.agentDir, next, expectedConfigRevision);
		this.configError = undefined;
		if (!next.enabled && this.state) {
			this.state.phase = "closed";
			this.state.resolution = "waived";
			this.blockedReason = undefined;
			this.persist();
		} else if (modelChanged && this.pending && this.state) {
			this.state.authorized = [];
			this.state.providerKey = this.modelKey();
			this.state.phase = "captured";
			this.persist();
		}
		this.status(ctx);
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
				!(await this.awaitDecision(ctx, "waiver", () =>
					ctx.ui.confirm("Disable pending quality gate?", "This explicitly waives the unresolved case."),
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
			const reason = this.blockedReason;
			if (
				!(await this.awaitDecision(ctx, "waiver", () =>
					ctx.ui.confirm("Waive unrecoverable quality state?", reason),
				))
			)
				return;
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
		if (this.state.approvedTargets) {
			this.state.phase = "applying";
		} else {
			const hasReviewFindings = Boolean(
				this.state.verdict?.edits.length ||
					this.state.lsp?.findings.length ||
					this.state.dry?.verdict?.findings.length,
			);
			const isAwaitingHumanReview = action === "resolve" && hasReviewFindings;
			this.state.phase = isAwaitingHumanReview ? "human" : "captured";
		}
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
