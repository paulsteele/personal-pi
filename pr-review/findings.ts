import { snapshotLines, type Snapshot } from "./snapshot.js";
import { safePath } from "./profile.js";
import type { Advisory, Candidate, Finding } from "./types.js";
export const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
export async function checkQuotedEvidence(
	evidence: Finding["evidence"][number],
	snapshot: Snapshot,
): Promise<void> {
	safePath(evidence.file);
	const quote = evidence.quote.replace(/\r\n/g, "\n"),
		count = quote.split("\n").length;
	const page = await snapshotLines(
		snapshot,
		evidence.file,
		evidence.side,
		evidence.line,
		count,
		quote.length + count + 2,
	);
	if (page.text.split(/\r?\n/).slice(0, count).join("\n") !== quote)
		throw new Error("Evidence quote does not match captured source");
}
export async function checkAdvisory(advisory: Omit<Advisory, "id">, snapshot: Snapshot): Promise<void> {
	if (!advisory.files.length || !advisory.evidence.length)
		throw new Error("Advisory needs changed-file scope and quoted evidence");
	for (const file of advisory.files) {
		safePath(file);
		if (!snapshot.changes.some((change) => change.file === file || change.oldPath === file))
			throw new Error("Advisory must concern changed files");
	}
	for (const evidence of advisory.evidence) await checkQuotedEvidence(evidence, snapshot);
}
export async function checkEvidence(finding: Finding, snapshot: Snapshot): Promise<void> {
	safePath(finding.file);
	const change = snapshot.changes.find((item) => item.file === finding.file || item.oldPath === finding.file);
	if (!change) throw new Error("Finding does not target a reviewed file");
	if (finding.endLine < finding.startLine) throw new Error("Invalid finding line range");
	const lineCount = snapshot.lineCount
		? await snapshot.lineCount(finding.file, finding.side)
		: (await snapshot.read(finding.file, finding.side)).toString().split(/\r?\n/).length;
	if (finding.endLine > lineCount) throw new Error("Finding line outside source");
	if (!change.metadataOnly) {
		let anchored: boolean;
		if (change.changedRanges) {
			const ranges = change.changedRanges[finding.side];
			let low = 0,
				high = ranges.length;
			while (low < high) {
				const middle = Math.floor((low + high) / 2);
				if (ranges[middle]![1] < finding.startLine) low = middle + 1;
				else high = middle;
			}
			anchored = low < ranges.length && ranges[low]![0] <= finding.endLine;
		} else
			anchored = [...(finding.side === "old" ? change.oldLines : change.newLines)].some(
				(line) => line >= finding.startLine && line <= finding.endLine,
			);
		if (!anchored) throw new Error("Finding does not anchor to a changed hunk");
	}
	let primary = false;
	for (const evidence of finding.evidence) {
		await checkQuotedEvidence(evidence, snapshot);
		const count = evidence.quote.replace(/\r\n/g, "\n").split("\n").length;
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
