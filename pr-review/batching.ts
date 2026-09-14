import type { Snapshot, Change } from "./snapshot.js";
import type { Candidate, Lens } from "./types.js";

export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export const documentBytes = (path: string, text: string): number => jsonBytes(path) + 1 + jsonBytes(text);
/** Kept as a packing utility, not a job/coverage limiter. Oversized patches become tool-backed references. */
export interface ReviewInput {
	project: string;
	lens: Lens;
	requiredDocuments: Record<string, string>;
	changes: Array<{ file: string; patch?: string }>;
	requiredReading?: string[];
}
export interface PreparedChange {
	part: { file: string; patch: string };
	bytes: number;
}
export async function prepareChanges(changes: Change[], signal: AbortSignal): Promise<PreparedChange[]> {
	const result: PreparedChange[] = [];
	for (const change of changes) {
		signal.throwIfAborted();
		const part = { file: change.file, patch: change.patch };
		result.push({ part, bytes: jsonBytes(part) });
	}
	return result;
}
export async function packReviewInputs(
	base: Omit<ReviewInput, "changes">,
	parts: PreparedChange[],
	options: { system: string; maxBytes: number; maxJobs?: number; signal: AbortSignal },
): Promise<{ inputs: ReviewInput[]; omitted: string[] }> {
	const inputs: ReviewInput[] = [];
	let current: ReviewInput = { ...base, changes: [] };
	for (const part of parts) {
		options.signal.throwIfAborted();
		const next = { ...current, changes: [...current.changes, part.part] };
		if (current.changes.length && jsonBytes(next) + Buffer.byteLength(options.system) > options.maxBytes) {
			inputs.push(current);
			current = { ...base, changes: [] };
		}
		const fits =
			jsonBytes({ ...current, changes: [...current.changes, part.part] }) +
				Buffer.byteLength(options.system) <=
			options.maxBytes;
		current.changes.push(fits ? part.part : { file: part.part.file });
	}
	if (current.changes.length) inputs.push(current);
	return { inputs, omitted: [] };
}
export interface VerificationInput {
	project: string;
	candidates: Candidate[];
	candidateIds: string[];
	requiredDocuments: Record<string, string>;
	requiredReading: string[];
	changes: Array<{ file: string; oldPath: string; metadataOnly: boolean; patch?: string }>;
}
export interface VerificationBatch {
	candidates: Candidate[];
	input: VerificationInput;
}
export async function packVerificationInputs(options: {
	project: string;
	candidates: Candidate[];
	lenses: Lens[];
	snapshot: Snapshot;
	system: string;
	maxBytes: number;
	maxJobs?: number;
	signal: AbortSignal;
}): Promise<{ batches: VerificationBatch[]; rejected: Array<{ id: string; reason: string }> }> {
	const batches: VerificationBatch[] = [];
	const input = (candidates: Candidate[], inline = true): VerificationInput => {
		const files = new Set(candidates.map((c) => c.file));
		return {
			project: options.project,
			candidates: inline ? candidates : [],
			candidateIds: candidates.map((c) => c.id),
			requiredDocuments: {},
			requiredReading: [
				...new Set(
					options.lenses
						.filter((lens) => candidates.some((c) => c.reviewer === lens.name))
						.flatMap((lens) => lens.reading),
				),
			],
			changes: options.snapshot.changes
				.filter((c) => files.has(c.file) || files.has(c.oldPath))
				.map((c) => ({ file: c.file, oldPath: c.oldPath, metadataOnly: c.metadataOnly })),
		};
	};
	let current: Candidate[] = [];
	const flush = () => {
		if (current.length) {
			const inline = input(current);
			batches.push({
				candidates: current,
				input:
					jsonBytes(inline) + Buffer.byteLength(options.system) <= options.maxBytes
						? inline
						: input(current, false),
			});
			current = [];
		}
	};
	for (const candidate of options.candidates) {
		options.signal.throwIfAborted();
		if (
			current.length &&
			(current.length === 10 ||
				jsonBytes(input([...current, candidate])) + Buffer.byteLength(options.system) > options.maxBytes)
		)
			flush();
		current.push(candidate);
	}
	flush();
	return { batches, rejected: [] };
}
