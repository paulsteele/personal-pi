import { matchesGlob } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Change } from "./snapshot.js";
import { BASELINES, type Draft, type Lens, type SpecialistDefinition } from "./types.js";
import type { Prompts } from "./prompts.js";

const baselineNames: Record<(typeof BASELINES)[number], string> = {
	security: "Security",
	performance: "Performance",
	correctness: "Correctness",
	style: "Style/Conventions",
	readability: "Human Readability",
};

export function triggers(specialist: SpecialistDefinition, changes: Change[]): boolean {
	return (
		specialist.always ||
		changes.some((change) =>
			specialist.anyOf.some((group) =>
				group.every((predicate) => {
					if (predicate.kind === "path")
						return matchesGlob(change.file, predicate.value) || matchesGlob(change.oldPath, predicate.value);
					return (predicate.kind === "added" ? change.added : change.removed).some((line) =>
						line.includes(predicate.value),
					);
				}),
			),
		)
	);
}
async function triggerFacts(draft: Draft, changes: Change[], signal?: AbortSignal): Promise<Change[]> {
	const predicates = draft.specialists.flatMap((specialist) => specialist.anyOf.flat());
	const added = [...new Set(predicates.filter((p) => p.kind === "added").map((p) => p.value))];
	const removed = [...new Set(predicates.filter((p) => p.kind === "removed").map((p) => p.value))];
	if (!added.length && !removed.length) return changes;
	const facts: Change[] = [];
	for (const change of changes) {
		signal?.throwIfAborted();
		if (!change.patchPath) {
			facts.push(change);
			continue;
		}
		const foundAdded = new Set<string>(),
			foundRemoved = new Set<string>();
		const stream = createReadStream(change.patchPath, { signal });
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
		let failure: Error | undefined;
		stream.once("error", (error) => {
			failure = error;
			lines.close();
		});
		let inHunk = false,
			count = 0;
		try {
			for await (const line of lines) {
				if (++count % 128 === 0) {
					await new Promise<void>((resolve) => setImmediate(resolve));
					signal?.throwIfAborted();
				}
				if (line.startsWith("@@ ")) {
					inHunk = true;
					continue;
				}
				if (!inHunk) continue;
				if (line.startsWith("+"))
					for (const needle of added)
						if (!foundAdded.has(needle) && line.slice(1).includes(needle)) foundAdded.add(needle);
				if (line.startsWith("-"))
					for (const needle of removed)
						if (!foundRemoved.has(needle) && line.slice(1).includes(needle)) foundRemoved.add(needle);
				if (foundAdded.size === added.length && foundRemoved.size === removed.length) break;
			}
		} finally {
			lines.close();
			stream.destroy();
		}
		if (failure) throw failure;
		signal?.throwIfAborted();
		facts.push({
			file: change.file,
			oldPath: change.oldPath,
			patch: "",
			added: [...foundAdded],
			removed: [...foundRemoved],
			oldLines: new Set(),
			newLines: new Set(),
			metadataOnly: change.metadataOnly,
		});
	}
	return facts;
}
export async function selectLenses(
	draft: Draft,
	changes: Change[],
	prompts: Prompts,
	signal?: AbortSignal,
): Promise<Lens[]> {
	const facts = await triggerFacts(draft, changes, signal);
	const result: Lens[] = BASELINES.map((id) => {
		const extra = draft.baselineFocus.find((item) => item.id === id);
		return {
			id,
			name: baselineNames[id],
			focus: `${prompts.text[`personas/${id}`]}\n${extra?.focus ?? ""}`,
			reading: [...new Set([...draft.requiredReading, ...(extra?.requiredReading ?? [])])],
			reason: "Mandatory shared baseline",
		};
	});
	for (const specialist of draft.specialists)
		if (triggers(specialist, facts))
			result.push({
				id: specialist.id,
				name: specialist.name,
				focus: specialist.focus,
				reading: [...new Set([...draft.requiredReading, ...specialist.requiredReading])],
				reason: specialist.always ? "Profile always-on specialist" : "Saved path/content trigger matched",
				...(specialist.always
					? {}
					: {
							matchedFiles: facts
								.filter((change) => triggers(specialist, [change]))
								.map((change) => change.file),
						}),
			});
	return result;
}
