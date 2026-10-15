import { expect, it } from "vitest";
import { lexicalWindows } from "./dry-lexical.mjs";
import {
	changedDryRanges,
	groupDryEvidence,
	retrieveDryCandidates,
	buildDryEvidence,
} from "./dry-retrieval.js";
import { digest } from "./proposal.js";
import type { DryIndexedFile, DryManifest } from "./dry-types.js";

function indexed(path: string, text: string): DryIndexedFile {
	return {
		path,
		hash: digest(text),
		format: "typescript",
		bytes: text.length,
		lines: text.split("\n").length,
		windows: lexicalWindows(text),
		suppressed: false,
	};
}
function scenario() {
	const changedText = "const retentionDays = 30;\nreturn retentionDays;";
	const existingText = "const accountRetention = 30;\nreturn accountRetention;";
	const files = [indexed("new.ts", changedText), indexed("existing.ts", existingText)];
	const manifest: DryManifest = {
		version: 1,
		revision: digest("manifest"),
		files,
		excluded: [],
		truncated: false,
		bytes: 100,
	};
	const changed = [{ path: "/repo/new.ts", before: "", after: changedText }];
	return {
		files,
		manifest,
		changed,
		texts: new Map([
			["new.ts", changedText],
			["existing.ts", existingText],
		]),
	};
}
it("retrieves a small policy rule below clone thresholds", () => {
	const h = scenario();
	const result = retrieveDryCandidates("/repo", h.changed, h.manifest, h.files, []);
	expect(result.candidates[0]?.counterpart).toBe("existing.ts");
	expect(result.candidates[0]?.signals).toContain("literal:30");
	expect(result.coverage[0]).toMatchObject({ outcome: "reviewed", selected: 1 });
});
it("deduplicates overlapping clone and lexical families", () => {
	const h = scenario();
	const result = retrieveDryCandidates("/repo", h.changed, h.manifest, h.files, [
		{
			snippet: { path: "new.ts", range: [1, 2] },
			counterpart: { path: "existing.ts", range: [1, 2] },
			kind: "renamed",
			tokens: 40,
		},
	]);
	expect(result.candidates).toHaveLength(1);
	expect(result.candidates[0]?.signals).toEqual(["clone:renamed"]);
});
it("queries new code against the baseline and keeps its current text in evidence", async () => {
	const retrievalScenario = scenario();
	const baselineFiles = [retrievalScenario.files[1]!];
	const currentText = "const updatedRetentionDays = 30;\nreturn updatedRetentionDays;";
	const changed = [{ path: "/repo/new.ts", before: "", after: currentText }];
	const currentFiles = [indexed("new.ts", currentText)];
	const result = retrieveDryCandidates(
		"/repo",
		changed,
		retrievalScenario.manifest,
		baselineFiles,
		[],
		currentFiles,
	);
	const evidence = await buildDryEvidence(
		"/repo",
		result.candidates,
		changed,
		baselineFiles,
		async (path) => retrievalScenario.texts.get(path)!,
		currentFiles,
	);
	expect(result.coverage[0]?.outcome).toBe("reviewed");
	expect(evidence[0]?.changed.text).toBe(currentText);
	expect(evidence[0]?.changed.hash).toBe(currentFiles[0]?.hash);
	expect(evidence[0]?.counterpart.text).toBe(retrievalScenario.texts.get("existing.ts"));
});
it("retains distinct same-file counterparts", () => {
	const h = scenario();
	const result = retrieveDryCandidates("/repo", h.changed, h.manifest, h.files, [
		{
			snippet: { path: "new.ts", range: [1, 2] },
			counterpart: { path: "new.ts", range: [1, 2] },
			kind: "exact",
			tokens: 40,
		},
		{
			snippet: { path: "new.ts", range: [1, 2] },
			counterpart: { path: "new.ts", range: [8, 9] },
			kind: "exact",
			tokens: 40,
		},
	]);
	expect(
		result.candidates
			.filter((candidate) => candidate.counterpart === "new.ts")
			.map((candidate) => candidate.counterpartRange),
	).toEqual([[8, 9]]);
});
it("retains complete cited evidence and splits without clipping pairs", async () => {
	const h = scenario();
	const result = retrieveDryCandidates("/repo", h.changed, h.manifest, h.files, []);
	const evidence = await buildDryEvidence(
		"/repo",
		result.candidates,
		h.changed,
		h.files,
		async (path) => h.texts.get(path)!,
	);
	expect(evidence[0]?.changed.file).toBe("/repo/new.ts");
	expect(evidence[0]?.counterpart.text).toBe(h.texts.get("existing.ts"));
	expect(groupDryEvidence([...evidence, ...evidence], 24000, 500)).toHaveLength(1);
	expect(() => groupDryEvidence(evidence, 10, 0)).toThrow("indivisible");
	expect(changedDryRanges(h.changed[0]!)).toEqual([[1, 2]]);
});
