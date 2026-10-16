import type { DryCorpusError } from "./dry-corpus.mjs";
import type { DrySuspectDirectory } from "./dry-suspects.mjs";

const MEBIBYTE = 1024 * 1024;
function mebibytes(bytes: number): string {
	return `${(bytes / MEBIBYTE).toFixed(1)} MiB`;
}
function profileLocation(profilePath: string): string {
	return `the DRY project profile (Settings → Code Quality → DRY Checking → Project retrieval profile, or ${profilePath})`;
}
function alignedRows(rows: Array<readonly [string, string]>): string[] {
	const labelWidth = Math.max(0, ...rows.map(([label]) => label.length));
	return rows.map(([label, detail]) => `  ${label.padEnd(labelWidth)}  ${detail}`);
}
export function suspectWarning(suspects: DrySuspectDirectory[], profilePath: string): string | undefined {
	if (!suspects.length) {
		return undefined;
	}
	const rows = suspects.map(
		(suspect) => [suspect.directory, `(${suspect.suspectSignal}, ${mebibytes(suspect.bytes)})`] as const,
	);
	return [
		"DRY is scanning directories that look vendored or generated:",
		...alignedRows(rows),
		`Add them to "exclude" in ${profileLocation(profilePath)}, or to "include" to keep scanning them silently.`,
	].join("\n");
}
function fileCount(files: number): string {
	return `${files} files`;
}
export function corpusErrorMessage(error: DryCorpusError, profilePath: string): string {
	const corpusTooLarge = error.kind === "corpus_too_large";
	const formatDirectoryWeight = corpusTooLarge ? mebibytes : fileCount;
	const heading = corpusTooLarge
		? `DRY corpus is ${mebibytes(error.total)}, over the ${mebibytes(error.limit)} limit.`
		: `DRY discovery found ${fileCount(error.total)}, over the ${error.limit} entry limit.`;
	const rows = error.largest.map((entry) => [entry.directory, formatDirectoryWeight(entry.weight)] as const);
	const weightWidth = Math.max(0, ...rows.map(([, weight]) => weight.length));
	const rightAlignedWeightRows = rows.map(
		([directory, weight]) => [directory, weight.padStart(weightWidth)] as const,
	);
	return [
		`${heading} Largest directories:`,
		...alignedRows(rightAlignedWeightRows),
		`Exclude vendored/generated directories in ${profileLocation(profilePath)}, e.g.`,
		`  "exclude": ${JSON.stringify(error.suggestedExclude)}`,
		"then run /quality dry refresh.",
	].join("\n");
}
