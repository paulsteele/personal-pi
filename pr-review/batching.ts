import type { Snapshot, Change } from "./snapshot.js";
import type { Candidate, Lens } from "./types.js";

export class JobBudgetExceeded extends Error {}
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export const documentBytes = (path: string, text: string): number => jsonBytes(path) + 1 + jsonBytes(text);
async function checkpoint(index: number, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	if (index % 32 === 0) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		signal.throwIfAborted();
	}
}
export interface ReviewInput {
	project: string;
	lens: Lens;
	requiredDocuments: Record<string, string>;
	changes: Array<{ file: string; patch: string }>;
}
export interface PreparedChange {
	part: ReviewInput["changes"][number];
	bytes: number;
}
export async function prepareChanges(changes: Change[], signal: AbortSignal): Promise<PreparedChange[]> {
	const result: PreparedChange[] = [];
	for (let i = 0; i < changes.length; i++) {
		await checkpoint(i, signal);
		const part = { file: changes[i]!.file, patch: changes[i]!.patch };
		result.push({ part, bytes: jsonBytes(part) });
	}
	return result;
}
/** JSON array contents add only item bytes and commas to the once-measured empty input. */
export async function packReviewInputs(
	base: Omit<ReviewInput, "changes">,
	parts: PreparedChange[],
	options: { system: string; maxBytes: number; maxJobs: number; signal: AbortSignal },
): Promise<{ inputs: ReviewInput[]; omitted: string[] }> {
	const fixed = Buffer.byteLength(options.system) + jsonBytes({ ...base, changes: [] });
	if (fixed > options.maxBytes) throw new Error("Fixed reviewer context exceeds input budget");
	const inputs: ReviewInput[] = [],
		omitted: string[] = [];
	let changes: ReviewInput["changes"] = [],
		bytes = fixed;
	const flush = () => {
		if (!changes.length) return;
		if (inputs.length >= options.maxJobs)
			throw new JobBudgetExceeded(
				"Review requires more jobs than configured budget; narrow the scope or adjust runtime limits",
			);
		inputs.push({ ...base, changes });
		changes = [];
		bytes = fixed;
	};
	for (let i = 0; i < parts.length; i++) {
		await checkpoint(i, options.signal);
		const item = parts[i]!;
		if (fixed + item.bytes > options.maxBytes) {
			omitted.push(item.part.file);
			continue;
		}
		if (bytes + item.bytes + (changes.length ? 1 : 0) > options.maxBytes) flush();
		bytes += item.bytes + (changes.length ? 1 : 0);
		changes.push(item.part);
	}
	flush();
	return { inputs, omitted };
}
export interface VerificationInput {
	project: string;
	candidates: Candidate[];
	requiredDocuments: Record<string, string>;
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
	maxJobs: number;
	signal: AbortSignal;
}): Promise<{ batches: VerificationBatch[]; rejected: Array<{ id: string; reason: string }> }> {
	const batches: VerificationBatch[] = [],
		rejected: Array<{ id: string; reason: string }> = [];
	const documents = new Map<string, { text: string; bytes: number }>();
	const buckets = new Map<string, Candidate[]>();
	for (const candidate of options.candidates) {
		const bucket = buckets.get(candidate.file) ?? [];
		bucket.push(candidate);
		buckets.set(candidate.file, bucket);
	}
	let visited = 0;
	for (const [file, bucket] of buckets) {
		const changes = options.snapshot.changes
			.filter((change) => change.file === file || change.oldPath === file)
			.map((change) => ({
				file: change.file,
				oldPath: change.oldPath,
				metadataOnly: change.metadataOnly,
				...(change.metadataOnly ? { patch: change.patch } : {}),
			}));
		const fixed =
			Buffer.byteLength(options.system) +
			jsonBytes({ project: options.project, candidates: [], requiredDocuments: {}, changes });
		let candidates: Candidate[] = [],
			docs = new Map<string, string>(),
			bytes = fixed;
		const flush = () => {
			if (!candidates.length) return;
			if (batches.length >= options.maxJobs)
				throw new JobBudgetExceeded("Verification exceeds job budget; review is incomplete");
			batches.push({
				candidates,
				input: { project: options.project, candidates, requiredDocuments: Object.fromEntries(docs), changes },
			});
			candidates = [];
			docs = new Map();
			bytes = fixed;
		};
		for (const candidate of bucket) {
			await checkpoint(visited++, options.signal);
			const candidateBytes = jsonBytes(candidate);
			const reading = [
				...new Set(
					options.lenses.filter((lens) => lens.name === candidate.reviewer).flatMap((lens) => lens.reading),
				),
			];
			let alone = fixed + candidateBytes;
			try {
				if (alone > options.maxBytes) throw new Error("Single verification candidate exceeds input budget");
				for (let i = 0; i < reading.length; i++) {
					await checkpoint(i, options.signal);
					const path = reading[i]!;
					let doc = documents.get(path);
					if (!doc) {
						const text = (await options.snapshot.read(path)).toString();
						doc = { text, bytes: documentBytes(path, text) };
						if (doc.bytes > options.maxBytes)
							throw new Error("Required verification document exceeds input budget");
						documents.set(path, doc);
					}
					alone += doc.bytes + (i ? 1 : 0);
					if (alone > options.maxBytes)
						throw new Error("Single verification candidate and required context exceed input budget");
				}
			} catch (error) {
				options.signal.throwIfAborted();
				rejected.push({
					id: candidate.id,
					reason: error instanceof Error ? error.message : "Verification context unavailable",
				});
				continue;
			}
			const increment = () => {
				const missing = reading.filter((path) => !docs.has(path));
				return (
					candidateBytes +
					(candidates.length ? 1 : 0) +
					missing.reduce((sum, path) => sum + documents.get(path)!.bytes, 0) +
					(missing.length ? missing.length - (docs.size ? 0 : 1) : 0)
				);
			};
			if (candidates.length === 10 || bytes + increment() > options.maxBytes) flush();
			bytes += increment();
			for (const path of reading) docs.set(path, documents.get(path)!.text);
			candidates.push(candidate);
		}
		flush();
	}
	return { batches, rejected };
}
