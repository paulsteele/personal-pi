import type { Change } from "./snapshot.js";
import { hash } from "./prompts.js";
import { BASELINES, type Lens, type ReviewArea } from "./types.js";

export interface ReviewTaskPlan {
	id: string;
	lens: Lens;
	files: string[];
	areas: string[];
	contextFiles: string[];
	architecture: boolean;
}
export function reviewAreas(
	changes: Change[],
	proposed?: ReviewArea[],
): { areas: ReviewArea[]; fallback: boolean } {
	const known = new Set(changes.map((change) => change.file));
	if (proposed?.length) {
		const ids = new Set(proposed.map((area) => area.id)),
			covered = new Set<string>();
		let valid = ids.size === proposed.length;
		for (const area of proposed) {
			if (!area.files.length || area.related.some((id) => !ids.has(id) || id === area.id)) valid = false;
			for (const file of area.files) {
				if (!known.has(file) || covered.has(file)) valid = false;
				covered.add(file);
			}
		}
		if (valid && covered.size === known.size) return { areas: proposed, fallback: false };
	}
	const groups = new Map<string, string[]>();
	for (const file of known) {
		const root = file.includes("/") ? file.split("/")[0]! : ".";
		const files = groups.get(root) ?? [];
		files.push(file);
		groups.set(root, files);
	}
	return {
		fallback: true,
		areas: [...groups].map(([name, files], i) => ({
			id: `area-${i + 1}`,
			name: name === "." ? "Repository root" : name,
			files,
			reason: "Deterministic path grouping (semantic area plan unavailable)",
			related: [],
		})),
	};
}
export function planReviewTasks(
	lenses: Lens[],
	areas: ReviewArea[],
	changes: Change[],
	architectureFocus: string,
): ReviewTaskPlan[] {
	const all = changes.map((change) => change.file);
	const architecture: Lens = {
		id: "$architecture",
		name: "Architecture / Integration",
		focus: architectureFocus,
		reading: [
			...new Set(lenses.filter((l) => BASELINES.some((id) => id === l.id)).flatMap((l) => l.reading)),
		],
		reason: "Mandatory whole-change contracts and integration review",
	};
	const jobs: ReviewTaskPlan[] = [];
	for (const lens of [architecture, ...lenses]) {
		if (!lens.matchedFiles) {
			jobs.push({
				id: `review:${lens.id}`,
				lens,
				files: all,
				areas: areas.map((a) => a.id),
				contextFiles: [],
				architecture: lens.id === architecture.id,
			});
			continue;
		}
		const selected = areas.filter((area) => area.files.some((file) => lens.matchedFiles!.includes(file)));
		const remaining = new Set(selected.map((a) => a.id));
		while (remaining.size) {
			const group = new Set<string>([remaining.values().next().value!]);
			for (const id of group) {
				remaining.delete(id);
				for (const area of selected)
					if (
						remaining.has(area.id) &&
						(area.related.includes(id) || areas.find((a) => a.id === id)?.related.includes(area.id))
					)
						group.add(area.id);
			}
			const assigned = areas.filter((a) => group.has(a.id));
			const files = assigned.flatMap((a) => a.files);
			const related = new Set(assigned.flatMap((a) => a.related));
			jobs.push({
				id: `review:${hash(JSON.stringify([lens.id, assigned.map((a) => a.id).sort()]))}`,
				lens,
				files,
				areas: assigned.map((a) => a.id),
				contextFiles: areas
					.filter((a) => related.has(a.id))
					.flatMap((a) => a.files)
					.filter((file) => !files.includes(file)),
				architecture: false,
			});
		}
	}
	if (new Set(jobs.map((job) => job.id)).size !== jobs.length)
		throw new Error("Duplicate planned review task IDs");
	const priority = (job: ReviewTaskPlan) =>
		["$architecture", "correctness", "security", "performance", "style"].indexOf(job.lens.id);
	return jobs.sort((a, b) => {
		const pa = priority(a),
			pb = priority(b);
		return (
			(pa < 0 ? 5 : pa) - (pb < 0 ? 5 : pb) || b.files.length - a.files.length || a.id.localeCompare(b.id)
		);
	});
}
