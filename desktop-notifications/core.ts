import { basename } from "node:path";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

export type AssistantLike = {
	role?: unknown;
	content?: unknown;
	stopReason?: unknown;
};

export type BranchEntryLike = {
	type?: unknown;
	message?: AssistantLike;
};

export type AskUserPromptLike = {
	questions?: unknown;
};

export type AskUserNotification = {
	subtitle: string;
	body: string;
};

/** Build notification copy from the ask-user plugin's JSON-safe prompt event. */
export function askUserNotification(event: AskUserPromptLike): AskUserNotification | undefined {
	if (!Array.isArray(event.questions)) return undefined;
	const questions = event.questions
		.map((item) =>
			typeof item === "object" && item !== null && typeof (item as { question?: unknown }).question === "string"
				? (item as { question: string }).question.trim()
				: "",
		)
		.filter(Boolean);
	if (questions.length === 0) return undefined;
	if (questions.length === 1) return { subtitle: "Question needs your input", body: questions[0] };
	return {
		subtitle: `${questions.length} questions need your input`,
		body: `${questions[0]} (+${questions.length - 1} more)`,
	};
}

const QUALITY_DECISION_NOTICES = {
	arbitration: { subtitle: "Quality decision needed", body: "Choose the current code, proposed corrections, or another review cycle." },
	coverage: { subtitle: "Quality coverage needs approval", body: "Authorize this file's review or waive its quality check." },
	failure: { subtitle: "Quality review needs attention", body: "Retry the review, select a reviewer, or waive the quality check." },
	scope: { subtitle: "Quality scope needs approval", body: "Approve or decline the requested correction scope expansion." },
	model: { subtitle: "Quality reviewer selection needed", body: "Select the model for quality review." },
	waiver: { subtitle: "Quality waiver needs confirmation", body: "Confirm or decline waiving the pending quality gate." },
} satisfies Record<string, AskUserNotification>;

type QualityDecisionKind = keyof typeof QUALITY_DECISION_NOTICES;
type QualityAttentionChange = { action: "show"; notification: AskUserNotification } | { action: "clear" };

export function createQualityAttentionTracker(sessionId: string) {
	const pending = new Map<string, QualityDecisionKind>();
	return {
		get active(): boolean { return pending.size > 0; },
		update(raw: unknown): QualityAttentionChange | undefined {
			if (!raw || typeof raw !== "object") return;
			const event = raw as { version?: unknown; sessionId?: unknown; requestId?: unknown; kind?: unknown; active?: unknown };
			if (event.version !== 1 || event.sessionId !== sessionId ||
				typeof event.requestId !== "string" || !event.requestId || event.requestId.length > 240 ||
				typeof event.kind !== "string" || !Object.hasOwn(QUALITY_DECISION_NOTICES, event.kind) ||
				typeof event.active !== "boolean") return;
			const kind = event.kind as QualityDecisionKind;
			if (event.active) {
				if (pending.has(event.requestId)) return;
				pending.set(event.requestId, kind);
				return { action: "show", notification: QUALITY_DECISION_NOTICES[kind] };
			}
			if (pending.get(event.requestId) !== kind) return;
			const wasLatestPendingDecision = [...pending.keys()].at(-1) === event.requestId;
			pending.delete(event.requestId);
			if (!wasLatestPendingDecision) return;
			const remainingDecisionKind = [...pending.values()].at(-1);
			return remainingDecisionKind ? { action: "show", notification: QUALITY_DECISION_NOTICES[remainingDecisionKind] } : { action: "clear" };
		},
	};
}

export function textFromAssistant(message: AssistantLike | undefined): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

/** Return only the newest successfully finalized assistant response. */
export function latestFinalAssistantText(entries: readonly BranchEntryLike[]): string {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		if (["error", "aborted", "toolUse", "pending"].includes(String(entry.message.stopReason ?? ""))) continue;
		const text = textFromAssistant(entry.message);
		if (text.trim()) return text;
	}
	return "";
}

/** Convert assistant Markdown into a compact, safe notification preview. */
export function normalizeNotificationText(value: string): string {
	return value
		.replace(ANSI_ESCAPE, "")
		.replace(CONTROL_CHARACTERS, "")
		.replace(/```[^\n]*\n?/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/[\r\n\t ]+/g, " ")
		.trim();
}

export function truncateUnicode(value: string, maxCodePoints: number): string {
	if (!Number.isInteger(maxCodePoints) || maxCodePoints < 1) return "";
	const points = Array.from(value);
	if (points.length <= maxCodePoints) return value;
	if (maxCodePoints === 1) return "…";
	return `${points.slice(0, maxCodePoints - 1).join("").trimEnd()}…`;
}

export function notificationPreview(value: string, maxCodePoints = 220, fallback = "Ready for input"): string {
	const normalized = normalizeNotificationText(value);
	return truncateUnicode(normalized || fallback, maxCodePoints);
}

export function safeProjectLabel(cwd: string): string {
	const raw = basename(cwd.replace(/[\\/]+$/, "")) || "project";
	const clean = raw.replace(CONTROL_CHARACTERS, "").replace(/[\r\n\t]+/g, " ").trim();
	return truncateUnicode(clean || "project", 64);
}

export function encodeArgument(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

export function decodeArgument(value: string): string | undefined {
	if (!isBase64(value)) return undefined;
	try {
		const decoded = Buffer.from(value, "base64");
		if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) return undefined;
		return decoded.toString("utf8");
	} catch {
		return undefined;
	}
}

export function isBase64(value: string): boolean {
	return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

export function isMacWindowId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isHyprlandAddress(value: unknown): value is string {
	return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
}

export function replacementKey(platform: "mac" | "hyprland", nativeId: number | string): string {
	const value = String(nativeId).toLowerCase();
	if (platform === "mac" && !isMacWindowId(Number(nativeId))) throw new Error("Invalid macOS window id");
	if (platform === "hyprland" && !isHyprlandAddress(value)) throw new Error("Invalid Hyprland address");
	return `pi-${platform}-${value.replace(/^0x/, "")}`;
}
