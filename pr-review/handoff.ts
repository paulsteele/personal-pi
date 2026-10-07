import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { redact } from "./report.js";
import { formatUsage } from "./usage.js";
import type { Report } from "./types.js";

/** Native boilerplate is not a discussion request; substantive approval notes are. */
export function hasDiscussionFeedback(feedback: string): boolean {
	const value = feedback.trim();
	return value.length > 0 && !/^LGTM(?:\s*[-–—]\s*no changes requested\.?)?\.?$/i.test(value);
}
export function redactedData<T>(value: T): T {
	return JSON.parse(
		JSON.stringify(value, (_key, item) => (typeof item === "string" ? redact(item) : item)),
	) as T;
}

export function actionPayload(report: Report) {
	const browser = report.browser;
	const requestedIds = browser?.decision === "feedback" ? browser.requestedIds : [];
	const hasDiscussion = Boolean(
		browser && (browser.discussion.length || hasDiscussionFeedback(browser.feedback)),
	);
	const requested = new Set(requestedIds);
	let findings: Report["findings"];
	if (hasDiscussion) {
		findings = report.findings;
	} else {
		findings = report.findings.filter((finding) => requested.has(finding.id));
	}
	const includedIds = new Set(findings.map((finding) => finding.id));
	return redactedData({
		version: 1 as const,
		reportId: report.id,
		repoId: report.repoId,
		project: report.project,
		scope: report.scope,
		baseline: report.baseline,
		head: report.head,
		fingerprint: report.fingerprint,
		status: report.status,
		issues: report.issues,
		contextNotes: report.contextNotes ?? [],
		omitted: report.omitted,
		browser: {
			decision: browser?.decision ?? "unavailable",
			requestedIds,
			feedback: browser?.feedback ?? "",
			discussion: browser?.discussion ?? [],
		},
		findings,
		groups: report.groups.filter((group) => group.some((id) => includedIds.has(id))),
		advisories: hasDiscussion ? (report.advisories ?? []) : [],
		advisoryAuthorization: "Unverified design advisories are discussion only; no fixes authorized.",
	});
}
export type ActionPayload = ReturnType<typeof actionPayload>;

export function compactSummary(report: Report): string {
	const lines = [
		"# Code Review Summary",
		`Project: ${report.project}; status: ${report.status}; changed files: ${report.changedFiles}.`,
		"Independent evidence review; tests/builds were not run.",
		...report.findings.map(
			(finding) =>
				`- [${finding.severity}] ${finding.id}: ${finding.title} — ${finding.file}:${finding.startLine}-${finding.endLine} (${finding.side})`,
		),
		...(report.advisories ?? []).map(
			(advisory) => `- ${advisory.id}: ${advisory.title} — UNVERIFIED, discussion only.`,
		),
		`Reported usage: ${formatUsage(report.usage)}. Elapsed: ${Math.round(report.elapsedMs / 1000)}s.`,
	];
	if (!report.findings.length) {
		lines.push(
			report.status === "complete"
				? "No verified findings retained."
				: "No verified findings retained. This is not a clean-pass claim.",
		);
	}
	return redact(lines.join("\n"));
}

function completeActionMessage(
	prefix: string,
	reportId: string,
	actionText: string,
	locator: string,
): string {
	return `${prefix}\n\n${JSON.stringify({ actionComplete: true, reportId })}\n# Action payload\n${actionText}\nUse this complete action payload; no report retrieval is required.${locator}`;
}

function omittedActionMessage(prefix: string, reportId: string, locator: string): string {
	return `${prefix}\n\n${JSON.stringify({ actionComplete: false, reportId })}\nAction payload omitted because it exceeds the inline budget. Before editing or resolving feedback, call pr_review_result with ${JSON.stringify({ reportId, section: "action", cursor: 0 })}. Concatenate text fragments and follow nextOffset until null. Only then interpret the complete action JSON. No preview authorizes acting without the complete payload.${locator}`;
}

export function reviewOutcome(
	report: Report,
	path: string,
	instructions: string,
): { text: string; handoff: boolean; actionComplete: boolean } {
	const browser = report.browser;
	const requestedIds = browser?.decision === "feedback" ? browser.requestedIds : [];
	const handoff = Boolean(
		browser && (requestedIds.length || browser.discussion.length || hasDiscussionFeedback(browser.feedback)),
	);
	const authorization = requestedIds.length
		? "Only the explicitly requested verified findings are authorized for fixes. Address human constraints before editing."
		: "NO FIXES AUTHORIZED. Do not apply suggested changes from this report. Any feedback or approval notes are discussion only.";
	const idsText = JSON.stringify(requestedIds);
	const idsNotice =
		Buffer.byteLength(idsText) <= 4096
			? `Requested verified finding IDs: ${idsText}.`
			: "Requested verified finding IDs: retrieve the complete action payload; this list is not inlined.";
	const prefix = redact(
		[
			"# Review authorization",
			`Browser outcome: ${browser?.decision ?? "not completed / unavailable"}.`,
			authorization,
			idsNotice,
			"Read browser.feedback, browser.discussion, findings, and groups in the action payload before acting. Duplicate groups describe one fix; only requested IDs authorize changes. Design advisories are unverified discussion only.",
			instructions,
		].join("\n\n"),
	);
	const locator = `\nAudit report (optional; no filesystem read required): ${redact(path)}`;
	const actionText = JSON.stringify(actionPayload(report));
	const completeText = completeActionMessage(prefix, report.id, actionText, locator);
	let text: string;
	const actionComplete = fitsResult(completeText);
	if (actionComplete) {
		text = completeText;
	} else {
		text = omittedActionMessage(prefix, report.id, locator);
	}
	if (!fitsResult(text)) {
		throw new Error("Review authorization header exceeds the result budget");
	}
	const summaryHeading = "\n\n# Optional review summary\n";
	const summary = truncateHead(compactSummary(report), {
		maxBytes: Math.max(1, DEFAULT_MAX_BYTES - Buffer.byteLength(text + summaryHeading) - 100),
		maxLines: Math.max(1, DEFAULT_MAX_LINES - (text + summaryHeading).split("\n").length - 2),
	});
	const summarized =
		text +
		summaryHeading +
		summary.content +
		(summary.truncated ? "\n[Optional summary truncated; actionComplete is unchanged.]" : "");
	if (fitsResult(summarized)) {
		text = summarized;
	}
	return { text, handoff, actionComplete };
}
export function fitsResult(text: string): boolean {
	return Buffer.byteLength(text) <= DEFAULT_MAX_BYTES && text.split("\n").length <= DEFAULT_MAX_LINES;
}

export function displayOutcome(result: { text: string; path?: string; actionComplete?: boolean }): string {
	if (result.actionComplete !== undefined) {
		if (!fitsResult(result.text)) {
			throw new Error("Pre-budgeted review result exceeds display limits");
		}
		return result.text;
	}
	const locator = result.path ? `\nAudit report (optional): ${result.path}` : "";
	const notice = "\n[Display truncated.]";
	const truncated = truncateHead(result.text, {
		maxBytes: Math.max(1, DEFAULT_MAX_BYTES - Buffer.byteLength(locator + notice)),
		maxLines: DEFAULT_MAX_LINES - 4,
	});
	return truncated.content + (truncated.truncated ? notice : "") + locator;
}
