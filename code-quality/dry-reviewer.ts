import { readFileSync } from "node:fs";
import type { QualityConfig } from "./config.js";
import { callQualityReviewer, type ReviewerRegistry, type ReviewerCallResult } from "./reviewer-call.js";
import { DryVerdictSchema, validateDryVerdict, type DryEvidence, type DryVerdict } from "./dry-types.js";

export const DRY_POLICY = readFileSync(new URL("./dry-policy.md", import.meta.url), "utf8");
const EXAMPLES = readFileSync(new URL("./dry-examples.md", import.meta.url), "utf8");
const SYSTEM = `${DRY_POLICY}\n\n${EXAMPLES}\n\nYou are an isolated DRY judge. Use only supplied pairs. Submit submit_dry_verdict exactly once, with no prose outside the submission and no edits field. Never browse, execute tools, or invent context. A finding must quote its pair's eligible changed line and counterpart range. Similarity is retrieval evidence, not a verdict. Return a fresh complete verdict after validation feedback; unsupported inferences are not findings.`;
export function dryReviewOverhead(notes: string[], objection?: string): number {
	return (
		SYSTEM.length +
		JSON.stringify(DryVerdictSchema).length +
		JSON.stringify(notes).length +
		(objection?.length ?? 0) +
		2000
	);
}
export type DryReviewResult = ReviewerCallResult<DryVerdict>;
export async function reviewDry(options: {
	piSessionId?: string;
	registry: ReviewerRegistry;
	config: QualityConfig;
	evidence: DryEvidence[];
	notes: string[];
	objection?: string;
	previousFindings?: unknown;
	signal?: AbortSignal;
	onAttempt?(attempt: number): void;
}): Promise<DryReviewResult> {
	if ((options.objection?.length ?? 0) > 2000) {
		return {
			kind: "unavailable",
			reason: "DRY disagreement exceeds 2000 characters",
			metrics: { requests: 0, latencyMs: 0, usages: [] },
		};
	}
	const scope = JSON.stringify(
		options.evidence.map((pair) => ({
			id: pair.id,
			changed: pair.changed.file,
			eligible: pair.changed.changedRanges,
			counterpart: pair.counterpart.file,
			range: pair.counterpart.range,
		})),
	);
	const input = JSON.stringify({
		pairs: options.evidence,
		scope,
		previousFindings: options.previousFindings,
		agentDisagreement: options.objection,
		untrusted: true,
	});
	return callQualityReviewer({
		...options,
		config: {
			...options.config,
			maxInputChars: options.config.dryMaxInputChars,
			maxOutputTokens: options.config.dryMaxOutputTokens,
		},
		systemPrompt: `${SYSTEM}\n\nTrusted operator notes for this case only:\n${JSON.stringify(options.notes)}`,
		input,
		scope,
		toolName: "submit_dry_verdict",
		schema: DryVerdictSchema,
		validate: (value) => validateDryVerdict(value, options.evidence),
	});
}
