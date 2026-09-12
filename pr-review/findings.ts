import type { Snapshot } from "./snapshot.js";
import { safePath } from "./profile.js";
import type { Candidate, Finding } from "./types.js";
export const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
export async function checkEvidence(finding: Finding, snapshot: Snapshot): Promise<void> {
	safePath(finding.file);
	const change = snapshot.changes.find((item) => item.file === finding.file || item.oldPath === finding.file);
	if (!change) throw new Error("Finding does not target a reviewed file");
	if (finding.endLine < finding.startLine) throw new Error("Invalid finding line range");
	const fileLines = (await snapshot.read(finding.file, finding.side)).toString().split(/\r?\n/);
	if (finding.endLine > fileLines.length) throw new Error("Finding line outside source");
	const anchors = finding.side === "old" ? change.oldLines : change.newLines;
	if (
		!change.metadataOnly &&
		![...anchors].some((line) => line >= finding.startLine && line <= finding.endLine)
	)
		throw new Error("Finding does not anchor to a changed hunk");
	let primary = false;
	for (const evidence of finding.evidence) {
		safePath(evidence.file);
		const source = (await snapshot.read(evidence.file, evidence.side)).toString().split(/\r?\n/);
		const quote = evidence.quote.replace(/\r\n/g, "\n");
		const count = quote.split("\n").length;
		if (source.slice(evidence.line - 1, evidence.line - 1 + count).join("\n") !== quote)
			throw new Error("Evidence quote does not match captured source");
		if (
			evidence.file === finding.file &&
			evidence.side === finding.side &&
			evidence.line <= finding.endLine &&
			evidence.line + count - 1 >= finding.startLine
		)
			primary = true;
	}
	if (!primary) throw new Error("Missing primary quoted evidence");
}
export function exactGroups(findings: Candidate[]): string[][] {
	const groups = new Map<string, string[]>();
	for (const finding of findings) {
		const key = JSON.stringify([
			finding.file,
			finding.side,
			finding.startLine,
			finding.endLine,
			finding.problem.trim(),
			finding.suggestion.trim(),
		]);
		const group = groups.get(key) ?? [];
		group.push(finding.id);
		groups.set(key, group);
	}
	return [...groups.values()];
}
export function validateGroups(groups: string[][], findings: Candidate[]): string[][] {
	const byId = new Map(findings.map((finding) => [finding.id, finding]));
	const seen = new Set<string>();
	for (const group of groups) {
		if (!group.length) throw new Error("Empty finding group");
		for (const id of group) {
			if (!byId.has(id) || seen.has(id)) throw new Error("Invalid/duplicate grouped finding ID");
			seen.add(id);
		}
		for (const a of group)
			for (const b of group) {
				const left = byId.get(a)!,
					right = byId.get(b)!;
				if (
					left.file !== right.file ||
					left.side !== right.side ||
					left.endLine < right.startLine ||
					right.endLine < left.startLine
				)
					throw new Error("Unrelated locations cannot be merged");
			}
	}
	if (seen.size !== findings.length) throw new Error("Consolidation omitted findings");
	return groups;
}
export function representatives(
	findings: Candidate[],
	groups: string[][],
): Array<{ primary: Candidate; members: Candidate[] }> {
	const byId = new Map(findings.map((finding) => [finding.id, finding]));
	return groups
		.map((group) => {
			const members = group
				.map((id) => byId.get(id)!)
				.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
			return { primary: members[0]!, members };
		})
		.sort(
			(a, b) =>
				severityRank[a.primary.severity] - severityRank[b.primary.severity] ||
				a.primary.file.localeCompare(b.primary.file) ||
				a.primary.startLine - b.primary.startLine,
		);
}
