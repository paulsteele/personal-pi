import type { SnapshotFile } from "./capture.js";
import type { QualityConfig } from "./config.js";
import { groupDryEvidence, rangesOverlap } from "./dry-retrieval.js";
import { dryReviewOverhead, reviewDry } from "./dry-reviewer.js";
import type { ReviewerRegistry, ReviewMetrics } from "./reviewer-call.js";
import type { SandboxDryManager } from "./dry-sandbox-manager.js";
import type { DryAssessment, DryVerdict } from "./dry-types.js";

export interface DryCheckRequest {
	files: SnapshotFile[];
	authorized: string[];
	config: QualityConfig;
	registry: ReviewerRegistry;
	piSessionId: string;
	revision: string;
	notes: string[];
	objection?: string;
	previousFindings?: unknown;
	signal: AbortSignal;
	onAttempt?(attempt: number): void;
}
export type DryCheckResult =
	| { kind: "checked"; assessment: DryAssessment; metrics: ReviewMetrics }
	| { kind: "unavailable" | "failed" | "cancelled" | "stale"; reason: string; metrics: ReviewMetrics };
export interface DryGate {
	check(request: DryCheckRequest): Promise<DryCheckResult>;
	current(signal: AbortSignal): Promise<boolean>;
	readonly revision: string;
	readonly configRevision: string;
}
export function createDryGate(manager: SandboxDryManager): DryGate {
	return {
		get revision() {
			return manager.revision;
		},
		get configRevision() {
			return manager.configRevision;
		},
		current: (signal) => manager.current(signal),
		async check(request) {
			const metrics: ReviewMetrics = { requests: 0, latencyMs: 0, usages: [] };
			const started = Date.now();
			try {
				const prepared = await manager.prepare(request.files, request.authorized, request.signal);
				const baselineGeneration = manager.generationId;
				const incomplete = prepared.coverage.find((coverage) => coverage.outcome === "incomplete");
				if (incomplete) {
					throw new Error(`DRY coverage incomplete for ${incomplete.file}: ${incomplete.reason}`);
				}
				const groups = groupDryEvidence(
					prepared.evidence,
					request.config.dryMaxInputChars,
					dryReviewOverhead(request.notes, request.objection),
				);
				const findings: DryVerdict["findings"] = [];
				const reviewedEvidence: typeof prepared.evidence = [];
				for (const group of groups) {
					const evidence = await manager.retainCurrentCounterparts(group, request.authorized, request.signal);
					if (!evidence.length) {
						continue;
					}
					reviewedEvidence.push(...evidence);
					const response = await reviewDry({ ...request, evidence });
					metrics.requests += response.metrics.requests;
					metrics.usages.push(...response.metrics.usages);
					if (response.kind !== "verdict") {
						return {
							kind: response.kind === "oversized" ? "unavailable" : response.kind,
							reason: response.reason,
							metrics,
						};
					}
					findings.push(...response.value.findings);
				}
				if (findings.length > 24) {
					throw new Error("Combined DRY findings exceed 24; use a smaller batch or explicit recovery");
				}
				if (!(await manager.current(request.signal)) || baselineGeneration !== manager.generationId) {
					return { kind: "stale", reason: "DRY baseline belongs to a retired turn or sandbox", metrics };
				}
				const currentEvidence = await manager.retainCurrentCounterparts(
					reviewedEvidence,
					request.authorized,
					request.signal,
				);
				const currentPairIds = new Set(currentEvidence.map((pair) => pair.id));
				const currentFindings = findings.filter((finding) => currentPairIds.has(finding.pairId));
				const coverage = prepared.coverage.map((entry) => {
					const overlapsEntry = (pair: (typeof currentEvidence)[number]) =>
						pair.changed.file === entry.file &&
						entry.ranges.some((range) => rangesOverlap(pair.changed.range, range));
					const selected = currentEvidence.filter(overlapsEntry).length;
					const outcome =
						entry.outcome === "reviewed" && !selected ? ("no_candidates" as const) : entry.outcome;
					return { ...entry, selected, outcome };
				});
				metrics.latencyMs = Date.now() - started;
				const assessment: DryAssessment = {
					evidence: currentEvidence,
					coverage,
					revision: request.revision,
					manifestRevision: prepared.manifestRevision,
					configuration: manager.configRevision,
					generation: baselineGeneration,
					providerKey: `${request.config.provider}/${request.config.model}`,
					verdict: currentEvidence.length
						? {
								verdict: currentFindings.length ? "needs_work" : "approved",
								rationale: currentFindings.length
									? "Consolidate the cited shared knowledge"
									: "Supplied pairs contain no supported DRY violation",
								findings: currentFindings,
							}
						: undefined,
				};
				const latestStatus = {
					outcome: currentFindings.length
						? "needs_work"
						: currentEvidence.length
							? "reviewed"
							: "no_candidates",
					retrieved: prepared.coverage.reduce((count, coverage) => count + coverage.retrieved, 0),
					selected: currentEvidence.length,
					requests: metrics.requests,
					latencyMs: metrics.latencyMs,
					inputTokens: metrics.usages.reduce((count, usage) => count + usage.input, 0),
					outputTokens: metrics.usages.reduce((count, usage) => count + usage.output, 0),
				};
				manager.updateLatest(latestStatus);
				return { kind: "checked", assessment, metrics };
			} catch (error) {
				metrics.latencyMs = Date.now() - started;
				return { kind: request.signal.aborted ? "cancelled" : "unavailable", reason: String(error), metrics };
			}
		},
	};
}
