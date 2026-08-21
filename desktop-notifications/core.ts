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
