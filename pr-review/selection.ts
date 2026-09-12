import { matchesGlob } from "node:path";
import type { Change } from "./snapshot.js";
import { BASELINES, type Draft, type Lens, type SpecialistDefinition } from "./types.js";
import type { Prompts } from "./prompts.js";
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
export function selectLenses(draft: Draft, changes: Change[], prompts: Prompts): Lens[] {
	const result: Lens[] = BASELINES.map((id) => {
		const extra = draft.baselineFocus.find((item) => item.id === id);
		return {
			id,
			name: id === "style" ? "Style/Conventions" : `${id[0]!.toUpperCase()}${id.slice(1)}`,
			focus: `${prompts.text[`personas/${id}`]}\n${extra?.focus ?? ""}`,
			reading: [...new Set([...draft.requiredReading, ...(extra?.requiredReading ?? [])])],
			reason: "Mandatory shared baseline",
		};
	});
	for (const specialist of draft.specialists)
		if (triggers(specialist, changes))
			result.push({
				id: specialist.id,
				name: specialist.name,
				focus: specialist.focus,
				reading: [...new Set([...draft.requiredReading, ...specialist.requiredReading])],
				reason: specialist.always ? "Profile always-on specialist" : "Saved path/content trigger matched",
			});
	return result;
}
