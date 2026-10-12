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

export interface QualityReviewCounts {
	checkCount: number;
	rejectionCount: number;
}

const QUALITY_LSP_PHASES = [
	"connecting",
	"starting",
	"loading",
	"ready",
	"checking",
	"stopping",
	"stopped",
	"failed",
	"disabled",
	"unconfigured",
] as const;
function validLspText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 240 &&
		!/[\u0000-\u001f\u007f-\u009f]/.test(value)
	);
}
export interface QualityLspServer {
	id: string;
	name: string;
	root: string;
	phase: (typeof QUALITY_LSP_PHASES)[number];
	clients: number;
	queued?: boolean;
}

export interface QualityHeader extends QualityActivity, QualityReviewCounts {
	sessionId: string;
	modelId: string;
	lsp?: QualityLspServer[];
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

function parseQualityLspServer(value: unknown): QualityLspServer | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const server = value as Record<string, unknown>;
	if (!validLspText(server.id) || !validLspText(server.name) || !validLspText(server.root)) return;
	if (!(QUALITY_LSP_PHASES as readonly unknown[]).includes(server.phase)) return;
	if (
		!nonnegativeInteger(server.clients) ||
		(server.queued !== undefined && typeof server.queued !== "boolean")
	)
		return;
	return {
		id: server.id,
		name: server.name,
		root: server.root,
		phase: server.phase as QualityLspServer["phase"],
		clients: server.clients,
		...(server.queued === undefined ? {} : { queued: server.queued }),
	};
}

export function parseQualityHeader(value: unknown): QualityHeader | undefined {
	const status = parseStatus(value);
	if (!status) return;
	const { modelId, checkCount = 0, rejectionCount = 0 } = value as Record<string, unknown>;
	if (!nonnegativeInteger(checkCount) || !nonnegativeInteger(rejectionCount)) return;
	if (
		typeof modelId !== "string" ||
		modelId.length === 0 ||
		modelId.length > 240 ||
		/[\u0000-\u001f\u007f-\u009f]/.test(modelId)
	)
		return;
	const rawLsp = (value as Record<string, unknown>).lsp;
	let lsp: QualityLspServer[] | undefined;
	if (rawLsp !== undefined) {
		if (!Array.isArray(rawLsp) || rawLsp.length > 32) return;
		lsp = [];
		for (const value of rawLsp) {
			const server = parseQualityLspServer(value);
			if (!server) return;
			lsp.push(server);
		}
	}
	return { ...status, modelId, checkCount, rejectionCount, ...(lsp === undefined ? {} : { lsp }) };
}
