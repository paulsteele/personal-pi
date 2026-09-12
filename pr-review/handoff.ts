import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { renderReport } from "./report.js";
import type { Report } from "./types.js";

/** Native boilerplate is not a discussion request; substantive approval notes are. */
export function hasDiscussionFeedback(feedback: string): boolean {
	const value = feedback.trim();
	return value.length > 0 && !/^LGTM(?:\s*[-–—]\s*no changes requested\.?)?\.?$/i.test(value);
}
export function reviewOutcome(
	report: Report,
	path: string,
	instructions: string,
): { text: string; handoff: boolean } {
	const browser = report.browser;
	const requestedIds = browser?.decision === "feedback" ? browser.requestedIds : [];
	const handoff = Boolean(
		browser && (requestedIds.length || browser.discussion.length || hasDiscussionFeedback(browser.feedback)),
	);
	const authorization = requestedIds.length
		? "Only the explicitly requested verified findings are authorized for fixes. Read the full report and human constraints before editing."
		: "NO FIXES AUTHORIZED. Do not apply suggested changes from this report. Any feedback or approval notes are discussion only.";
	const prefix = [
		"# Review authorization",
		`Browser outcome: ${browser?.decision ?? "not completed / unavailable"}.`,
		authorization,
		`Requested verified finding IDs: ${JSON.stringify(requestedIds)}.`,
		`Full structured report: ${path}`,
		"Read browser.feedback, browser.discussion, findings, and groups in that report before acting. Duplicate groups describe one fix.",
		instructions,
	].join("\n\n");
	return { text: `${prefix}\n\n${renderReport(report)}`, handoff };
}
/** Preserve both the authorization prefix and a visible full-report locator on every display path. */
export function displayOutcome(result: { text: string; path?: string }): string {
	const locator = result.path ? `\nFull structured report: ${result.path}` : "";
	const notice = "\n[Display truncated; read the complete report before acting.]";
	const truncated = truncateHead(result.text, {
		maxBytes: Math.max(1, DEFAULT_MAX_BYTES - Buffer.byteLength(locator + notice)),
		maxLines: DEFAULT_MAX_LINES - 4,
	});
	return truncated.content + (truncated.truncated ? notice : "") + locator;
}
