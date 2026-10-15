export interface SidebarDryStatus {
	toolPhase: "unavailable" | "validating" | "ready" | "off";
	scanPhase: "idle" | "scanning" | "ready" | "limited" | "unavailable" | "off";
	version?: string;
	executable?: string;
	scope?: string;
	revision?: string;
	files: number;
	windows: number;
	bytes: number;
	excluded: number;
	formatCount: number;
	astFormatCount: number;
	cloneCounts: { exact: number; renamed: number; gap: number; ast: number };
	lastScanAt?: number;
	scanDurationMs?: number;
	formats?: Array<{ name: string; files: number }>;
	latest?: {
		outcome: string;
		retrieved: number;
		selected: number;
		requests: number;
		latencyMs: number;
		inputTokens: number;
		outputTokens: number;
	};
	reason?: string;
}
function boundedText(value: unknown, maxChars = 4096): value is string {
	return typeof value === "string" && value.length <= maxChars && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function finiteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
export function parseDryStatus(value: unknown): SidebarDryStatus | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const allowedToolPhases = ["unavailable", "validating", "ready", "off"];
	const allowedScanPhases = ["idle", "scanning", "ready", "limited", "unavailable", "off"];
	if (
		!allowedToolPhases.includes(String(raw.toolPhase)) ||
		!allowedScanPhases.includes(String(raw.scanPhase))
	) {
		return undefined;
	}
	const fields = ["files", "windows", "bytes", "excluded", "formatCount", "astFormatCount"] as const;
	if (fields.some((field) => !finiteCount(raw[field]))) {
		return undefined;
	}
	const clones = raw.cloneCounts as Record<string, unknown> | undefined;
	if (!clones || ["exact", "renamed", "gap", "ast"].some((kind) => !finiteCount(clones[kind]))) {
		return undefined;
	}
	const status: SidebarDryStatus = {
		toolPhase: raw.toolPhase as SidebarDryStatus["toolPhase"],
		scanPhase: raw.scanPhase as SidebarDryStatus["scanPhase"],
		files: raw.files as number,
		windows: raw.windows as number,
		bytes: raw.bytes as number,
		excluded: raw.excluded as number,
		formatCount: raw.formatCount as number,
		astFormatCount: raw.astFormatCount as number,
		cloneCounts: {
			exact: clones.exact as number,
			renamed: clones.renamed as number,
			gap: clones.gap as number,
			ast: clones.ast as number,
		},
	};
	for (const field of ["version", "executable", "scope", "revision", "reason"] as const) {
		if (raw[field] !== undefined) {
			if (!boundedText(raw[field])) {
				return undefined;
			}
			status[field] = raw[field];
		}
	}
	for (const field of ["lastScanAt", "scanDurationMs"] as const) {
		if (finiteCount(raw[field])) {
			status[field] = raw[field];
		}
	}
	if (raw.formats !== undefined) {
		if (!Array.isArray(raw.formats) || raw.formats.length > 32) {
			return undefined;
		}
		status.formats = [];
		for (const format of raw.formats) {
			if (!format || !boundedText(format.name, 80) || !finiteCount(format.files)) {
				return undefined;
			}
			status.formats.push({ name: format.name, files: format.files });
		}
	}
	if (raw.latest && typeof raw.latest === "object") {
		const latest = raw.latest as Record<string, unknown>;
		const metrics = [
			"retrieved",
			"selected",
			"requests",
			"latencyMs",
			"inputTokens",
			"outputTokens",
		] as const;
		if (!boundedText(latest.outcome, 80) || metrics.some((field) => !finiteCount(latest[field]))) {
			return undefined;
		}
		status.latest = {
			outcome: latest.outcome,
			retrieved: latest.retrieved as number,
			selected: latest.selected as number,
			requests: latest.requests as number,
			latencyMs: latest.latencyMs as number,
			inputTokens: latest.inputTokens as number,
			outputTokens: latest.outputTokens as number,
		};
	}
	return status;
}
