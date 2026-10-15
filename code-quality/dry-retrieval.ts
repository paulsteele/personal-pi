import { join } from "node:path";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { lexicalFeatures } from "./dry-lexical.mjs";
import { digest } from "./proposal.js";
import type { SnapshotFile } from "./capture.js";
import { exclusionRule } from "./exclusions.js";
import type {
	DryClone,
	DryCoverage,
	DryEvidence,
	DryIndexedFile,
	DryLineRange,
	DryManifest,
	DrySource,
} from "./dry-types.js";

export interface DryCandidate {
	file: string;
	changedRange: DryLineRange;
	counterpart: string;
	counterpartRange: DryLineRange;
	signals: string[];
	score: number;
}
export function rangesOverlap(left: DryLineRange, right: DryLineRange): boolean {
	return left[0] <= right[1] && right[0] <= left[1];
}
export function changedDryRanges(file: SnapshotFile): DryLineRange[] {
	const patch = generateUnifiedPatch(file.path, file.before ?? "", file.after ?? "", 0);
	const ranges: DryLineRange[] = [];
	for (const header of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
		const start = Math.max(1, Number(header[1]));
		const count = Number(header[2] ?? 1);
		ranges.push([start, Math.max(start, start + count - 1)]);
	}
	return ranges;
}
function cloneCandidates(path: string, range: DryLineRange, clones: DryClone[]): DryCandidate[] {
	const candidates: DryCandidate[] = [];
	for (const clone of clones) {
		const changedSnippet = clone.snippet;
		const baselineCounterpart = clone.counterpart;
		const isOverlappingSameFileClone =
			baselineCounterpart.path === path && rangesOverlap(changedSnippet.range, baselineCounterpart.range);
		if (
			changedSnippet.path !== path ||
			!rangesOverlap(changedSnippet.range, range) ||
			isOverlappingSameFileClone
		) {
			continue;
		}
		candidates.push({
			file: path,
			changedRange: changedSnippet.range,
			counterpart: baselineCounterpart.path,
			counterpartRange: baselineCounterpart.range,
			signals: [`clone:${clone.method ?? clone.kind}`],
			score: 1000 + clone.tokens,
		});
	}
	return candidates;
}
function lexicalCandidates(
	path: string,
	range: DryLineRange,
	text: string,
	files: DryIndexedFile[],
): DryCandidate[] {
	const windows = files.flatMap((file) => file.windows.map((window) => ({ file: file.path, ...window })));
	const frequencies = new Map<string, number>();
	for (const window of windows) {
		for (const feature of window.features) {
			frequencies.set(feature, (frequencies.get(feature) ?? 0) + 1);
		}
	}
	const query = new Set(lexicalFeatures(text));
	const maxCommonFrequency = Math.max(3, windows.length * 0.1);
	const candidates: DryCandidate[] = [];
	for (const window of windows) {
		if (window.file === path && rangesOverlap(window.range, range)) {
			continue;
		}
		const shared = window.features.filter(
			(feature) => query.has(feature) && (frequencies.get(feature) ?? 0) <= maxCommonFrequency,
		);
		const hasPolicyLiteral = shared.some((feature) => feature.startsWith("literal:"));
		if (shared.length < 2 && !hasPolicyLiteral) {
			continue;
		}
		const score = shared.reduce((total, feature) => {
			const frequency = frequencies.get(feature) ?? 0;
			const inverseFrequency = Math.log((1 + windows.length) / (1 + frequency)) + 1;
			const domainWeight = feature.startsWith("call:") || feature.startsWith("literal:") ? 2 : 1;
			return total + inverseFrequency * domainWeight;
		}, 0);
		candidates.push({
			file: path,
			changedRange: range,
			counterpart: window.file,
			counterpartRange: window.range,
			signals: shared.slice(0, 12),
			score,
		});
	}
	return candidates;
}
function diverseCandidates(candidates: DryCandidate[]): DryCandidate[] {
	const selected: DryCandidate[] = [];
	const orderedCandidates = candidates.sort((left, right) => {
		const scoreDifference = right.score - left.score;
		const fileOrder = left.counterpart.localeCompare(right.counterpart);
		const rangeOrder = left.counterpartRange[0] - right.counterpartRange[0];
		return scoreDifference || fileOrder || rangeOrder;
	});
	for (const candidate of orderedCandidates) {
		const overlappingFamily = selected.some(
			(existing) =>
				existing.counterpart === candidate.counterpart &&
				rangesOverlap(existing.counterpartRange, candidate.counterpartRange),
		);
		if (overlappingFamily) {
			continue;
		}
		selected.push(candidate);
		if (selected.length === 3) {
			break;
		}
	}
	return selected;
}
export function retrieveDryCandidates(
	root: string,
	changed: SnapshotFile[],
	manifest: DryManifest,
	files: DryIndexedFile[],
	clones: DryClone[],
	queryFiles: DryIndexedFile[] = files,
): { candidates: DryCandidate[]; coverage: DryCoverage[] } {
	const candidates: DryCandidate[] = [];
	const coverage: DryCoverage[] = [];
	for (const source of changed) {
		const path = source.path.startsWith(`${root}/`) ? source.path.slice(root.length + 1) : undefined;
		const ranges = changedDryRanges(source);
		if (source.after === null) {
			coverage.push({
				file: source.path,
				ranges,
				outcome: "unsupported",
				retrieved: 0,
				selected: 0,
				reason: "Deleted source has no post-edit representation",
			});
			continue;
		}
		const indexed = queryFiles.find((file) => file.path === path);
		if (!indexed || !path) {
			const exclusion = manifest.excluded.find((entry) => entry.path === path);
			const unsupported =
				exclusionRule(source.path) ||
				/\.(md|mdx|rst|txt)$/i.test(source.path) ||
				exclusion?.reason === "unsupported/document";
			let outcome: "outside-index" | "unsupported" | "incomplete";
			if (!path) {
				outcome = "outside-index";
			} else if (unsupported) {
				outcome = "unsupported";
			} else {
				outcome = "incomplete";
			}
			coverage.push({
				file: source.path,
				ranges,
				outcome,
				retrieved: 0,
				selected: 0,
				reason: exclusion?.reason ?? "File is outside the indexed corpus",
			});
			continue;
		}
		for (const range of ranges) {
			const changedText = (source.after ?? "")
				.split("\n")
				.slice(range[0] - 1, range[1])
				.join("\n");
			const retrieved = [
				...cloneCandidates(path, range, clones),
				...lexicalCandidates(path, range, changedText, files),
			];
			const selected = diverseCandidates(retrieved);
			candidates.push(...selected);
			coverage.push({
				file: source.path,
				ranges: [range],
				outcome: selected.length ? "reviewed" : "no_candidates",
				retrieved: retrieved.length,
				selected: selected.length,
			});
		}
	}
	return { candidates, coverage };
}
export async function buildDryEvidence(
	root: string,
	candidates: DryCandidate[],
	changed: SnapshotFile[],
	files: DryIndexedFile[],
	excerpt: (path: string, range: DryLineRange, hash: string) => Promise<string>,
	queryFiles: DryIndexedFile[] = files,
): Promise<DryEvidence[]> {
	const evidence = new Map<string, DryEvidence>();
	for (const candidate of candidates) {
		const changedFile = queryFiles.find((file) => file.path === candidate.file)!;
		const counterpartFile = files.find((file) => file.path === candidate.counterpart)!;
		const changedSnapshot = changed.find((file) => file.path === join(root, candidate.file))!;
		const contextLines = 6;
		const changedRange: DryLineRange = [
			Math.max(1, candidate.changedRange[0] - contextLines),
			Math.min(changedFile.lines, candidate.changedRange[1] + contextLines),
		];
		const counterpartRange: DryLineRange = [
			Math.max(1, candidate.counterpartRange[0] - contextLines),
			Math.min(counterpartFile.lines, candidate.counterpartRange[1] + contextLines),
		];
		const id = digest(
			JSON.stringify([
				candidate.file,
				changedRange,
				candidate.counterpart,
				counterpartRange,
				changedFile.hash,
				counterpartFile.hash,
			]),
		);
		const source = async (
			file: DryIndexedFile,
			range: DryLineRange,
			changedRanges: DryLineRange[],
		): Promise<DrySource> => ({
			file: join(root, file.path),
			range,
			hash: file.hash,
			text: await excerpt(file.path, range, file.hash),
			changedRanges,
		});
		evidence.set(id, {
			id,
			changed: {
				file: join(root, changedFile.path),
				range: changedRange,
				hash: changedFile.hash,
				text: (changedSnapshot.after ?? "")
					.split("\n")
					.slice(changedRange[0] - 1, changedRange[1])
					.join("\n"),
				changedRanges: changedDryRanges(changedSnapshot),
			},
			counterpart: await source(counterpartFile, counterpartRange, []),
			signals: candidate.signals,
			score: candidate.score,
		});
	}
	return [...evidence.values()];
}
export function groupDryEvidence(
	evidence: DryEvidence[],
	maxInputChars: number,
	overheadChars: number,
): DryEvidence[][] {
	const groups: DryEvidence[][] = [];
	let group: DryEvidence[] = [];
	for (const pair of evidence) {
		if (JSON.stringify([pair]).length + overheadChars > maxInputChars) {
			throw new Error("An indivisible DRY evidence pair exceeds the input budget");
		}
		if (group.length === 6 || JSON.stringify([...group, pair]).length + overheadChars > maxInputChars) {
			groups.push(group);
			group = [];
		}
		group.push(pair);
	}
	if (group.length) {
		groups.push(group);
	}
	return groups;
}
