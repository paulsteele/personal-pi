export interface DryDirectoryWeight {
	directory: string;
	weight: number;
}
export interface DryLargestDirectories {
	total: number;
	largest: DryDirectoryWeight[];
	suggestedExclude: string[];
}
export interface DryCorpusError extends DryLargestDirectories {
	kind: "corpus_too_large" | "discovery_truncated";
	limit: number;
}
export function largestDirectories(weightByPath: Map<string, number>, limit: number): DryLargestDirectories;
export function corpusError(payload: DryCorpusError): Error;
export function parseCorpusError(text: string): DryCorpusError | undefined;
