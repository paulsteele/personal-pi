import type { Diagnostic, DiagnosticSeverity, Range } from "vscode-languageserver-protocol";

export interface LspFinding {
	file: string;
	serverId: string;
	provider?: string;
	severity?: DiagnosticSeverity;
	code?: string | number;
	message: string;
	range: Range;
	tags?: number[];
}
export type LspCheckResult =
	| {
			kind: "checked";
			findings: LspFinding[];
			generation: string;
			workspaceRevision: number;
			hashes: Record<string, string>;
			elapsedMs: number;
	  }
	| { kind: "stale" | "unavailable" | "cancelled"; reason: string };
export interface LspFileRequest {
	path: string;
	hash: string;
	languageId: string;
}
export type LspServerPhase =
	| "connecting"
	| "starting"
	| "loading"
	| "ready"
	| "checking"
	| "stopping"
	| "stopped"
	| "failed"
	| "disabled"
	| "unconfigured";
export interface LspServerStatus {
	id: string;
	name: string;
	root: string;
	phase: LspServerPhase;
	clients: number;
	generation?: string;
	workspaceRevision?: number;
	queued?: boolean;
	reason?: string;
}

export function diagnosticFinding(
	file: string,
	serverId: string,
	diagnostic: Diagnostic,
	provider?: string,
): LspFinding {
	if (!diagnostic || typeof diagnostic.message !== "string" || !diagnostic.range)
		throw new Error("Malformed diagnostic");
	for (const position of [diagnostic.range.start, diagnostic.range.end]) {
		if (
			!position ||
			!Number.isSafeInteger(position.line) ||
			position.line < 0 ||
			!Number.isSafeInteger(position.character) ||
			position.character < 0
		)
			throw new Error("Malformed diagnostic range");
	}
	if (diagnostic.severity !== undefined && ![1, 2, 3, 4].includes(diagnostic.severity))
		throw new Error("Unknown diagnostic severity");
	return {
		file,
		serverId,
		message: diagnostic.message,
		range: diagnostic.range,
		...(diagnostic.severity === undefined ? {} : { severity: diagnostic.severity }),
		...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
		...(diagnostic.tags === undefined ? {} : { tags: [...diagnostic.tags] }),
		...(provider ? { provider } : {}),
	};
}

export function diagnosticLabel(finding: LspFinding): string {
	const severityLabels: Record<DiagnosticSeverity, string> = {
		1: "error",
		2: "warning",
		3: "information",
		4: "hint",
	};
	const severity = finding.severity === undefined ? "diagnostic" : severityLabels[finding.severity];
	return `${finding.file}:${finding.range.start.line + 1}:${finding.range.start.character + 1} [${finding.serverId}/${severity}${finding.code === undefined ? "" : ` ${finding.code}`}] ${finding.message}`
		.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

export function uniqueFindings(findings: LspFinding[]): LspFinding[] {
	return [...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values()];
}
