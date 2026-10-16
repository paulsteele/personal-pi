import { expect, it } from "vitest";
import { largestDirectories, parseCorpusError, corpusError } from "./dry-corpus.mjs";

it("suggests the largest directories until the remaining corpus fits the limit", () => {
	const bytesByPath = new Map([
		["lib/packages/Newtonsoft/lib.xml", 100],
		["lib/countly/sdk.cs", 1],
		["packages/A/a.xml", 10],
		["packages/B/b.xml", 10],
		["Source/App/app.cs", 9],
		["root.cs", 2],
	]);
	expect(largestDirectories(bytesByPath, 25)).toEqual({
		total: 132,
		largest: [
			{ directory: "lib/packages", weight: 100 },
			{ directory: "packages", weight: 20 },
			{ directory: "Source/App", weight: 9 },
		],
		suggestedExclude: ["lib/packages", "packages"],
	});
});
it("suggests nothing when the corpus already fits", () => {
	const bytesByPath = new Map([["src/a.ts", 10]]);
	expect(largestDirectories(bytesByPath, 10).suggestedExclude).toEqual([]);
});
it("lists at most eight directories", () => {
	const bytesByPath = new Map(Array.from({ length: 12 }, (_, index) => [`dir${index}/file.ts`, index + 1]));
	expect(largestDirectories(bytesByPath, 0).largest).toHaveLength(8);
});
it("round-trips a corpus error through worker stderr", () => {
	const payload = {
		kind: "corpus_too_large" as const,
		total: 40,
		limit: 32,
		largest: [{ directory: "packages", weight: 30 }],
		suggestedExclude: ["packages"],
	};
	const stderr = `DRY worker failed: ${String(corpusError(payload))}`;
	expect(parseCorpusError(stderr)).toEqual(payload);
	expect(parseCorpusError("DRY worker failed: Error: jscpd exited")).toBeUndefined();
});
