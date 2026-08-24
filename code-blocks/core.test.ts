import { describe, expect, test } from "bun:test";
import { CODE_BLOCK_MARKER, extractMarkedBlocks, markCodeBlocks } from "./core.ts";

describe("markCodeBlocks", () => {
	test("marks backtick and tilde fences while preserving indentation and info", () => {
		const input = ["before", "```ts title=demo", "const n = 1;", "```", "  ~~~", "plain", "  ~~~", "after"].join("\n");
		expect(markCodeBlocks(input)).toBe(
			["before", `\`\`\`ts title=demo ${CODE_BLOCK_MARKER}`, "const n = 1;", "```", `  ~~~${CODE_BLOCK_MARKER}`, "plain", "  ~~~", "after"].join("\n"),
		);
	});

	test("does not mark fence-like lines inside a block", () => {
		const input = ["````md", "```ts", "inside", "```", "````"].join("\n");
		const output = markCodeBlocks(input);
		expect(output.split(CODE_BLOCK_MARKER)).toHaveLength(2);
		expect(output).toStartWith(`\`\`\`\`md ${CODE_BLOCK_MARKER}`);
	});

	test("is idempotent", () => {
		const once = markCodeBlocks("```js\nwork()\n```");
		expect(markCodeBlocks(once)).toBe(once);
	});

	test("ignores inline code and four-space-indented fences", () => {
		const input = "Use ```inline``` here\n    ```js\n    ignored\n    ```";
		expect(markCodeBlocks(input)).toBe(input);
	});
});

describe("extractMarkedBlocks", () => {
	test("extracts languages and bodies in source order", () => {
		const marked = markCodeBlocks("```ts\nconst a = 1;\n```\n\n~~~\nplain\n~~~");
		expect(extractMarkedBlocks(marked)).toEqual([
			{ language: "ts", code: "const a = 1;" },
			{ language: "", code: "plain" },
		]);
	});

	test("supports an unfinished streaming block", () => {
		const marked = markCodeBlocks("```sh\necho one\necho two");
		expect(extractMarkedBlocks(marked)).toEqual([
			{ language: "sh", code: "echo one\necho two" },
		]);
	});

	test("ignores ordinary unmarked fences", () => {
		expect(extractMarkedBlocks("```ts\nconst a = 1;\n```")).toEqual([]);
	});

	test("uses only the first info token as the language", () => {
		const marked = `\`\`\`tsx title=demo ${CODE_BLOCK_MARKER}\n<Component />\n\`\`\``;
		expect(extractMarkedBlocks(marked)).toEqual([{ language: "tsx", code: "<Component />" }]);
	});
});
