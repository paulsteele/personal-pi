export const QUALITY_CHECK_ENTRY = "code-quality:checking";
export const QUALITY_CHECK_UPDATE_ENTRY = "code-quality:check-update";

export type QualityCheckSource = "lsp" | "readability";
export type QualityCheckOutcome = "passed" | "failed" | "stale" | "interrupted";
export interface QualityCheckStage {
	source: QualityCheckSource;
	outcome?: QualityCheckOutcome;
}
export interface QualityCheckData {
	checkId: string;
	caseId: string;
	stages: QualityCheckStage[];
}

export function qualityCheckLabel(stage: QualityCheckStage): string {
	const label = `quality check: ${stage.source}`;
	switch (stage.outcome) {
		case "passed":
			return `${label} ✓`;
		case "failed":
			return `${label} ✕`;
		case "stale":
			return `${label} ✕ (outdated)`;
		case "interrupted":
			return `${label} ✕ (interrupted)`;
		default:
			return label;
	}
}

export type QualityFeedbackDetails =
	| { outcome: "rejected"; rejection: number; rejectionText?: string }
	| { outcome: "approved" | "waived" | "not_reviewed" | "applying" | "retrying" | "stale" | "awaiting_user" };

export function qualityFeedbackLabel(details: unknown): string {
	if (!details || typeof details !== "object") {
		return "quality";
	}
	const value = details as { outcome?: unknown; rejection?: unknown };
	switch (value.outcome) {
		case "approved":
			return "approved";
		case "waived":
			return "waived";
		case "not_reviewed":
			return "not reviewed";
		case "applying":
			return "applying approved proposal";
		case "retrying":
			return "retrying quality check";
		case "stale":
			return "quality check outdated";
		case "awaiting_user":
			return "awaiting your decision";
		case "rejected":
			return typeof value.rejection === "number" &&
				Number.isSafeInteger(value.rejection) &&
				value.rejection > 0
				? `handling rejection ${value.rejection}`
				: "handling rejection";
		default:
			return "quality";
	}
}
