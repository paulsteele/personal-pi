import { expect, it } from "vitest";
import { planReviewTasks, reviewAreas } from "./planning.js";
import { selectLenses } from "./selection.js";
import { loadPrompts } from "./prompts.js";
import { testDraft } from "./test-fixtures.js";
import type { Change } from "./snapshot.js";
const changes = Array.from(
	{ length: 72 },
	(_, i) =>
		({
			file: `${i < 36 ? "auth" : "ui"}/${i}.ts`,
			oldPath: `${i < 36 ? "auth" : "ui"}/${i}.ts`,
			patch: "diff",
			added: [],
			removed: [],
			oldLines: new Set(),
			newLines: new Set(),
			metadataOnly: false,
		}) as Change,
);
it("plans five whole-change tasks plus only relevant specialist areas, not reviewer x files", async () => {
	const lenses = await selectLenses(
		{
			...testDraft,
			specialists: [
				{
					id: "auth",
					name: "Auth",
					focus: "Auth flow",
					requiredReading: [],
					always: false,
					anyOf: [[{ kind: "path", value: "auth/**" }]],
				},
			],
		},
		changes,
		await loadPrompts(),
	);
	expect(lenses.at(-1)!.matchedFiles).toHaveLength(36);
	const { areas } = reviewAreas(changes);
	const jobs = planReviewTasks(lenses, areas, changes, "Cross-area contracts");
	expect(jobs).toHaveLength(6);
	expect(jobs.filter((job) => !job.lens.matchedFiles).every((job) => job.files.length === 72)).toBe(true);
	expect(jobs.at(-1)!.files.every((file) => file.startsWith("auth/"))).toBe(true);
	expect(jobs[0]!.architecture).toBe(true);
});
it("keeps ['a','b'] and ['a+b'] specialist tasks distinct and rejects duplicate identities", () => {
	const files = changes.slice(0, 3);
	const areas = [
		{ id: "a", name: "A", files: [files[0]!.file], reason: "test", related: ["b"] },
		{ id: "b", name: "B", files: [files[1]!.file], reason: "test", related: ["a"] },
		{ id: "a+b", name: "Combined name", files: [files[2]!.file], reason: "test", related: [] },
	];
	const lens = {
		id: "specialist",
		name: "Specialist",
		focus: "test",
		reading: [],
		reason: "test",
		matchedFiles: files.map((f) => f.file),
	};
	const jobs = planReviewTasks([lens], areas, files, "architecture");
	const specialized = jobs.filter((job) => !job.architecture);
	expect(specialized).toHaveLength(2);
	expect(new Set(specialized.map((job) => job.id)).size).toBe(2);
	const results = new Map(specialized.map((job, i) => [job.id, i === 0 ? ["finding"] : []]));
	expect([...results.values()].flat()).toEqual(["finding"]);
	expect(() => planReviewTasks([lens, lens], areas, files, "architecture")).toThrow("Duplicate");
});
it("rejects incomplete or overlapping area partitions without losing files", () => {
	const result = reviewAreas(changes, [
		{ id: "bad", name: "Bad", reason: "bad", related: [], files: [changes[0]!.file] },
	]);
	expect(result.fallback).toBe(true);
	expect(result.areas.flatMap((a) => a.files)).toHaveLength(72);
});
