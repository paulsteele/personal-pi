import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { Check } from "typebox/value";
import { lexicalFeatures, lexicalWindows, MAX_LEXICAL_FEATURE_CHARS } from "./dry-lexical.mjs";
import { DryEvidenceSchema } from "./dry-types.js";
import { assertIndexedFile, isIndexedFile } from "./dry-worker-schema.js";

it.each([
	{
		scenario: "Countly-shaped quoted digits",
		source: `Picture = "${"1234567890".repeat(80)}";`,
		family: "literal",
	},
	{ scenario: "unquoted number", source: "7".repeat(800), family: "literal" },
	{ scenario: "long identifier", source: `const ${"identifier".repeat(40)} = 1;`, family: "id" },
	{ scenario: "long identifier word", source: `const ${"identifier".repeat(40)} = 1;`, family: "word" },
	{ scenario: "qualified call", source: `namespace.${"operation".repeat(40)}();`, family: "call" },
])("bounds $scenario for index and evidence consumers", ({ source, family }) => {
	const features = lexicalFeatures(source);
	expect(features.some((feature) => feature.startsWith(`${family}:sha256:`))).toBe(true);
	expect(features.every((feature) => feature.length <= MAX_LEXICAL_FEATURE_CHARS)).toBe(true);
	expect(Check(DryEvidenceSchema.properties.signals, features.slice(0, 12))).toBe(true);
	const file = {
		path: "fixture.cs",
		hash: createHash("sha256").update(source).digest("hex"),
		format: "csharp",
		bytes: Buffer.byteLength(source),
		lines: 1,
		suppressed: false,
		windows: lexicalWindows(source),
	};
	expect(isIndexedFile(file)).toBe(true);
});
it("keeps the full oversized value distinct instead of truncating a common prefix", () => {
	const commonPrefix = "1234567890".repeat(80);
	const first = lexicalFeatures(`"${commonPrefix}1"`);
	const second = lexicalFeatures(`"${commonPrefix}2"`);
	expect(first).not.toEqual(second);
	expect(first).toEqual([`literal:sha256:${createHash("sha256").update(`${commonPrefix}1`).digest("hex")}`]);
});
it("reserves digest representations so literal input cannot impersonate a digest", () => {
	const longValue = "7".repeat(800);
	const digest = createHash("sha256").update(longValue).digest("hex");
	expect(lexicalFeatures(`"sha256:${digest}"`)).not.toEqual(lexicalFeatures(`"${longValue}"`));
});
it("counts the literal prefix in the evidence boundary", () => {
	expect(lexicalFeatures(`"${"a".repeat(152)}"`)).toContain(`literal:${"a".repeat(152)}`);
	expect(lexicalFeatures(`"${"a".repeat(153)}"`)).toContain(
		`literal:sha256:${createHash("sha256").update("a".repeat(153)).digest("hex")}`,
	);
});
it("identifies the file and schema location in malformed lexical output", () => {
	expect(() => assertIndexedFile({ path: "broken.cs" })).toThrow(/broken.cs:.*hash/);
});
