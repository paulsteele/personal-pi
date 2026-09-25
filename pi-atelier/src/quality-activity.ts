export type QualityActivityPhase =
	| "ready"
	| "pending"
	| "checking"
	| "needs_work"
	| "awaiting_user"
	| "applying"
	| "approved"
	| "user_approved"
	| "waived"
	| "excluded"
	| "unchanged"
	| "not_reviewed"
	| "paused"
	| "unconfigured"
	| "disabled"
	| "blocked";

export interface QualityActivity {
	phase: QualityActivityPhase;
	revision: number;
	correctionAttempt?: number;
	correctionLimit?: number;
	reviewAttempt?: number;
}

export interface QualityActivityEvent extends QualityActivity {
	sessionId: string;
	toolCallId: string;
}

export interface QualityHeader extends QualityActivity {
	sessionId: string;
	modelId: string;
}

const MAX_REVIEW_REQUESTS_WITH_REPAIR = 6;

const QUALITY_LABELS: Record<QualityActivityPhase, string> = {
	ready: "ready",
	pending: "pending",
	checking: "checking",
	needs_work: "needs work",
	awaiting_user: "awaiting you",
	applying: "applying proposal",
	approved: "approved",
	user_approved: "user approved",
	waived: "waived",
	excluded: "excluded · not reviewed",
	unchanged: "unchanged",
	not_reviewed: "not reviewed",
	paused: "paused",
	unconfigured: "select reviewer",
	disabled: "off",
	blocked: "blocked",
};

function validIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 160 &&
		!/[\u0000-\u001f\u007f-\u009f]/.test(value)
	);
}

function nonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseStatus(value: unknown): (QualityActivity & { sessionId: string }) | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const event = value as Record<string, unknown>;
	if (
		event.version !== 1 ||
		!validIdentifier(event.sessionId) ||
		typeof event.phase !== "string" ||
		!Object.hasOwn(QUALITY_LABELS, event.phase) ||
		!nonnegativeInteger(event.revision) ||
		event.revision === 0
	)
		return;
	const hasCorrections = event.correctionAttempt !== undefined || event.correctionLimit !== undefined;
	if (
		hasCorrections &&
		(!nonnegativeInteger(event.correctionAttempt) ||
			!nonnegativeInteger(event.correctionLimit) ||
			event.correctionLimit < 1 ||
			event.correctionAttempt > event.correctionLimit)
	)
		return;
	if (
		event.reviewAttempt !== undefined &&
		(!nonnegativeInteger(event.reviewAttempt) ||
			event.reviewAttempt < 1 ||
			event.reviewAttempt > MAX_REVIEW_REQUESTS_WITH_REPAIR)
	)
		return;
	return {
		sessionId: event.sessionId,
		phase: event.phase as QualityActivityPhase,
		revision: event.revision,
		...(hasCorrections
			? {
					correctionAttempt: event.correctionAttempt as number,
					correctionLimit: event.correctionLimit as number,
				}
			: {}),
		...(event.reviewAttempt === undefined ? {} : { reviewAttempt: event.reviewAttempt as number }),
	};
}

export function parseQualityActivity(value: unknown): QualityActivityEvent | undefined {
	const status = parseStatus(value);
	if (!status) return;
	const toolCallId = (value as Record<string, unknown>).toolCallId;
	return validIdentifier(toolCallId) ? { ...status, toolCallId } : undefined;
}

export function parseQualityHeader(value: unknown): QualityHeader | undefined {
	const status = parseStatus(value);
	if (!status) return;
	const modelId = (value as Record<string, unknown>).modelId;
	if (
		typeof modelId !== "string" ||
		modelId.length === 0 ||
		modelId.length > 240 ||
		/[\u0000-\u001f\u007f-\u009f]/.test(modelId)
	)
		return;
	return { ...status, modelId };
}
