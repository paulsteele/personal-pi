export const QUALITY_ACTIVITY_CHANNEL = "code-quality:activity";
export const QUALITY_STATUS_CHANNEL = "code-quality:status";
export const QUALITY_ACTIVITY_DISCOVER_CHANNEL = "code-quality:activity:discover";
export const MAX_QUALITY_ACTIVITY_CALLS = 96;

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

export interface QualityActivityStatus {
	phase: QualityActivityPhase;
	correctionAttempt?: number;
	correctionLimit?: number;
	reviewAttempt?: number;
}

export interface QualityActivityPublisher {
	reset(sessionId: string): void;
	begin(toolCallId: string): void;
	finishCollection(): void;
	update(status: QualityActivityStatus): void;
	updateHeader(status: QualityActivityStatus, modelId: string): void;
	finishTool(toolCallId: string, phase: QualityActivityPhase): void;
	dispose(): void;
}

export interface QualityActivityEvent extends QualityActivityStatus {
	version: 1;
	sessionId: string;
	toolCallId: string;
	revision: number;
}

export interface QualityHeaderEvent extends QualityActivityStatus {
	version: 1;
	sessionId: string;
	revision: number;
	modelId: string;
}

interface ActivityTransport {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export function createQualityActivityPublisher(events: ActivityTransport): QualityActivityPublisher {
	let sessionId = "";
	let revision = 0;
	let collecting = false;
	let disposed = false;
	let header: QualityHeaderEvent | undefined;
	const latest = new Map<string, QualityActivityEvent>();
	const batch = new Set<string>();
	const publish = (toolCallId: string, status: QualityActivityStatus): void => {
		if (disposed || !sessionId || !toolCallId || toolCallId.length > 160) return;
		const previous = latest.get(toolCallId);
		if (
			previous?.phase === status.phase &&
			previous.correctionAttempt === status.correctionAttempt &&
			previous.correctionLimit === status.correctionLimit &&
			previous.reviewAttempt === status.reviewAttempt
		)
			return;
		const event: QualityActivityEvent = {
			...status,
			version: 1,
			sessionId,
			toolCallId,
			revision: ++revision,
		};
		latest.set(toolCallId, event);
		while (latest.size > MAX_QUALITY_ACTIVITY_CALLS) {
			const oldest = latest.keys().next().value!;
			latest.delete(oldest);
			batch.delete(oldest);
		}
		try {
			events.emit(QUALITY_ACTIVITY_CHANNEL, { ...event });
		} catch {}
	};
	const unsubscribe = events.on(QUALITY_ACTIVITY_DISCOVER_CHANNEL, (request) => {
		if (disposed || !request || typeof request !== "object") return;
		const value = request as { version?: unknown; sessionId?: unknown };
		if (value.version !== 1 || value.sessionId !== sessionId) return;
		if (header) {
			try {
				events.emit(QUALITY_STATUS_CHANNEL, { ...header });
			} catch {}
		}
		for (const event of latest.values()) {
			try {
				events.emit(QUALITY_ACTIVITY_CHANNEL, { ...event });
			} catch {}
		}
	});
	return {
		reset(nextSessionId: string) {
			sessionId = nextSessionId;
			header = undefined;
			latest.clear();
			batch.clear();
			collecting = false;
		},
		begin(toolCallId: string) {
			if (disposed || !sessionId || !toolCallId || toolCallId.length > 160) return;
			if (!collecting) {
				batch.clear();
				collecting = true;
			}
			batch.add(toolCallId);
			publish(toolCallId, { phase: "pending" });
		},
		finishCollection() {
			collecting = false;
		},
		update(status: QualityActivityStatus) {
			if (collecting) return;
			for (const id of batch) publish(id, status);
			if (
				["approved", "user_approved", "waived", "unchanged", "not_reviewed", "disabled"].includes(
					status.phase,
				)
			)
				batch.clear();
		},
		updateHeader(status: QualityActivityStatus, modelId: string) {
			if (disposed || !sessionId) return;
			const publishedModelId = modelId.slice(0, 240);
			if (
				header?.phase === status.phase &&
				header.modelId === publishedModelId &&
				header.correctionAttempt === status.correctionAttempt &&
				header.correctionLimit === status.correctionLimit &&
				header.reviewAttempt === status.reviewAttempt
			)
				return;
			header = { ...status, version: 1, sessionId, modelId: publishedModelId, revision: ++revision };
			try {
				events.emit(QUALITY_STATUS_CHANNEL, { ...header });
			} catch {}
		},
		finishTool(toolCallId: string, phase: QualityActivityPhase) {
			batch.delete(toolCallId);
			publish(toolCallId, { phase });
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			header = undefined;
			try {
				unsubscribe();
			} catch {}
			latest.clear();
			batch.clear();
		},
	};
}
