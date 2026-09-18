import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { representatives } from "./findings.js";
import { publish, readStored } from "./storage.js";
import type { Advisory, Report } from "./types.js";
import { emptyUsage, sumUsage, formatUsage, formatCost, REQUEST_KINDS, type UsageTotals } from "./usage.js";

export function renderAdvisory(advisory: Advisory): string {
	return redact(
		`### ${advisory.id}: ${advisory.title}\n**UNVERIFIED DESIGN ADVISORY — discussion only; no fixes authorized.**\nAffected: ${advisory.files.join(", ")}\n\n${advisory.concern}\n\nRecommendation: ${advisory.recommendation}\n\nTradeoffs: ${advisory.tradeoffs}\n\n${advisory.evidence.map((e) => `${e.file}:${e.line} (${e.side}) — ${e.quote}`).join("\n")}`,
	);
}

export function redact(text: string): string {
	return text
		.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi, "Bearer [redacted]")
		.replace(
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
			"[redacted private key]",
		);
}
export function renderReport(report: Report): string {
	const lines = [
		"# Code Review Summary",
		"",
		`**Project:** ${report.project}`,
		`**Status:** ${report.status}`,
		`**Changed files in scope:** ${report.changedFiles}`,
		`**Model:** ${report.model}`,
		`**Reviewers:** ${report.lenses.map((lens) => lens.name).join(", ") || "none"}`,
		`**Source:** ${report.baseline ?? "empty tree"} → ${report.head ?? "unborn"} (${report.fingerprint.slice(0, 12)})`,
		"**Verification:** independent evidence review; tests/builds were not run",
		"",
	];
	if (report.contextNotes?.length)
		lines.push("## Context notes", ...report.contextNotes.map((note) => `- ${note}`), "");
	if (report.issues.length)
		lines.push("## Incomplete / limited areas", ...report.issues.map((issue) => `- ${issue}`), "");
	for (const { primary, members } of representatives(report.findings, report.groups))
		lines.push(
			`## [${primary.severity}] ${primary.id}: ${primary.title}`,
			`**File:** ${primary.file}:${primary.startLine}-${primary.endLine} (${primary.side})`,
			`**Reviewers:** ${[...new Set(members.map((item) => item.reviewer))].join(", ")}`,
			`**Problem:** ${primary.problem}`,
			`**Suggestion:** ${primary.suggestion}`,
			`**Rationale:** ${primary.rationale}`,
			...members.flatMap((item) =>
				item.evidence.map(
					(evidence) =>
						`**Verified at:** ${evidence.file}:${evidence.line} (${evidence.side})\n\n\`\`\`\n${evidence.quote}\n\`\`\``,
				),
			),
			"",
		);
	if (!report.findings.length) {
		if (report.status === "complete")
			lines.push(
				report.ledger.length
					? "All candidates were rejected during verification; none retained."
					: "All completed reviewers returned no findings.",
			);
		else lines.push("No verified findings retained. This is not a clean-pass claim.");
	}
	if (report.advisories?.length)
		lines.push(
			"",
			"## Unverified design advisories",
			"These judgments were not independently verified and are not eligible for automatic fix authorization.",
			...report.advisories.map(renderAdvisory),
		);
	if (report.tasks) {
		lines.push(
			"",
			"## Task execution and coverage",
			`${report.tasks.length} logical tasks; ${report.metrics?.modelRequests ?? "unknown"} model requests; ${report.metrics?.compactions ?? "unknown"} compactions; peak active ${report.metrics?.peakActive ?? "unknown"}.`,
		);
		for (const task of report.tasks)
			lines.push(
				`- ${task.name} [${task.state}] — ${task.files.length} files; ${task.remaining === undefined ? "coverage n/a" : `${(task.total ?? 0) - task.remaining}/${task.total} context resources supplied`}; ${task.turns} turns; ${task.retries} retries; ${task.startedAt && task.endedAt ? `${Math.round((task.endedAt - task.startedAt) / 1000)}s` : "not settled"}. ${task.reason}`,
			);
		lines.push(
			"Task durations overlap and can include recovery waits; they are not additive wall time. Scope acknowledgments do not guarantee every defect was detected.",
		);
	} else lines.push("", "Task execution metrics unavailable for this older report.");
	if (report.clean.length) lines.push("", "## Clean areas", ...report.clean.map((name) => `- ${name}`));
	if (report.declined.length)
		lines.push("", "## User-declined specialists", ...report.declined.map((name) => `- ${name}`));
	if (report.omitted.length)
		lines.push(
			"",
			"## Excluded / unavailable files",
			...report.omitted.map((item) => `- ${item.file}: ${item.reason}`),
		);
	if (report.ledger.length)
		lines.push(
			"",
			"## Verification ledger",
			...report.ledger.map(
				(entry) =>
					`- ${entry.id}: ${entry.verdict}${entry.sharedWith ? ` (shared verification with ${entry.sharedWith})` : ""} — ${entry.reason}`,
			),
		);
	lines.push(
		"",
		`Reported usage: ${formatUsage(report.usage)}. Elapsed: ${Math.round(report.elapsedMs / 1000)}s.`,
		formatCost(report.usage),
	);
	if (report.usage.byRequest)
		for (const kind of REQUEST_KINDS)
			lines.push(
				`- ${kind}: ${report.usage.byRequest[kind].requests} requests; ${formatUsage(report.usage.byRequest[kind])}; ${formatCost(report.usage.byRequest[kind])}`,
			);
	if (report.tasks) {
		const stages = new Map<string, UsageTotals>();
		for (const task of report.tasks)
			stages.set(task.stage, sumUsage(stages.get(task.stage) ?? emptyUsage(), task.usage));
		lines.push("", "## Usage by stage");
		for (const [stage, usage] of stages)
			lines.push(`- ${stage}: ${formatUsage(usage)}; ${formatCost(usage)}`);
	}
	return redact(lines.join("\n"));
}
export async function saveReport(root: string, report: Report, limit: number): Promise<void> {
	if (!/^[a-f0-9]{64}$/.test(report.repoId) || !/^[a-f0-9-]{36}$/.test(report.id))
		throw new Error("Invalid report identity");
	const directory = join(root, "repos", report.repoId, "reports");
	const path = join(directory, `${report.id}.json`);
	const current = await readStored(root, path);
	const safe = JSON.parse(
		JSON.stringify({ ...report, markdown: renderReport(report) }, (_key, value) =>
			typeof value === "string" ? redact(value) : value,
		),
	);
	await publish(root, path, safe, current?.revision);
	// Only delete recognized harness report records, never arbitrary files in the directory.
	const records: Array<{ path: string; createdAt: string }> = [];
	for (const name of await readdir(directory)) {
		if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
		try {
			const record = await readStored(root, join(directory, name));
			const value = record?.value as Partial<Report> | undefined;
			if (
				value?.version === 1 &&
				value.repoId === report.repoId &&
				`${value.id}.json` === name &&
				typeof value.createdAt === "string"
			)
				records.push({ path: join(directory, name), createdAt: value.createdAt });
		} catch {
			/* Leave unknown or malformed records alone. */
		}
	}
	records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	for (const record of records.slice(limit)) if (record.path !== path) await rm(record.path, { force: true });
}
