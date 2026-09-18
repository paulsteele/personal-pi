import { expect, it } from "vitest";
import { loadPrompts } from "./prompts.js";
import { selectLenses, triggers } from "./selection.js";
import { exactGroups, validateGroups } from "./findings.js";
import type { Change } from "./snapshot.js";
import type { Candidate, SpecialistDefinition } from "./types.js";
import { testDraft } from "./test-fixtures.js";
const change: Change = {
	file: "src/a.ts",
	oldPath: "src/a.ts",
	patch: "",
	added: ["await save();"],
	removed: [],
	oldLines: new Set(),
	newLines: new Set([1]),
	metadataOnly: false,
};
it("evaluates path/content AND predicates on the same changed file", () => {
	const specialist: SpecialistDefinition = {
		id: "persistence",
		name: "Persistence",
		focus: "Transactions",
		requiredReading: [],
		always: false,
		anyOf: [
			[
				{ kind: "path", value: "src/**" },
				{ kind: "added", value: "save(" },
			],
		],
	};
	expect(triggers(specialist, [change])).toBe(true);
	expect(
		triggers(specialist, [
			{ ...change, added: [] },
			{ ...change, file: "docs/a", oldPath: "docs/a" },
		]),
	).toBe(false);
});
it("always includes the five shared baselines for prose-only edits", async () => {
	expect(
		(await selectLenses(testDraft, [{ ...change, file: "README.md" }], await loadPrompts())).map(
			(lens) => lens.id,
		),
	).toEqual(["security", "performance", "correctness", "style", "readability"]);
});
it("supplements Human Readability without replacing its fixed focus or whole-change scope", async () => {
	const prompts = await loadPrompts();
	const lenses = await selectLenses(
		{
			...testDraft,
			requiredReading: ["AGENTS.md"],
			baselineFocus: [
				{
					id: "readability",
					focus: "Preserve the domain vocabulary",
					requiredReading: ["AGENTS.md", "docs/glossary.md"],
				},
			],
		},
		[change],
		prompts,
	);
	const readability = lenses.find((lens) => lens.id === "readability")!;
	expect(readability).toMatchObject({
		name: "Human Readability",
		focus: `${prompts.text["personas/readability"]}\nPreserve the domain vocabulary`,
		reading: ["AGENTS.md", "docs/glossary.md"],
		reason: "Mandatory shared baseline",
	});
	expect(readability.matchedFiles).toBeUndefined();
});
it("requires exhaustive duplicate groups and never merges unrelated locations", () => {
	const one = {
		id: "F1",
		file: "a",
		side: "new",
		startLine: 1,
		endLine: 1,
		problem: "p",
		suggestion: "s",
	} as Candidate;
	const two = { ...one, id: "F2", startLine: 9, endLine: 9 };
	expect(() => validateGroups([["F1"]], [one, two])).toThrow("omitted");
	expect(() => validateGroups([["F1", "F2"]], [one, two])).toThrow("Unrelated");
	expect(exactGroups([one, { ...one, id: "F3" }])).toEqual([["F1", "F3"]]);
});
