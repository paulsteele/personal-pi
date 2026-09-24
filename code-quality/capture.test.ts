import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";
import { readSnapshot, canonicalPath, buildReviewChunks, CoverageError } from "./capture.js";
import { newCase, recordVerdict, resolveCase, proposalApplied } from "./case.js";
import { CaseStore, latestReference, STATE_ENTRY } from "./state.js";
import { validateVerdict } from "./proposal.js";
const dirs: string[] = [];
function fixture() {
	const dir = canonicalPath(mkdtempSync(join(tmpdir(), "quality-capture-")));
	dirs.push(dir);
	const cwd = join(dir, "repo");
	mkdirSync(cwd);
	return { dir, cwd, path: join(cwd, "a.ts") };
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("captures exact text and absence, rejects binary/oversize/sensitive/external content", () => {
	const { dir, cwd, path } = fixture();
	expect(readSnapshot(path, DEFAULT_CONFIG, cwd)).toBeNull();
	writeFileSync(path, "\ufeffconst café = 1;\r\n");
	expect(readSnapshot(path, DEFAULT_CONFIG, cwd)).toBe("\ufeffconst café = 1;\r\n");
	expect(() => readSnapshot(path, { ...DEFAULT_CONFIG, maxFileBytes: 1 }, cwd)).toThrow(CoverageError);
	writeFileSync(path, Buffer.from([0, 255]));
	expect(() => readSnapshot(path, DEFAULT_CONFIG, cwd)).toThrow(/Binary/);
	writeFileSync(path, "Bearer " + "x".repeat(25));
	expect(() => readSnapshot(path, DEFAULT_CONFIG, cwd)).toThrow(/secret/);
	expect(readSnapshot(path, DEFAULT_CONFIG, cwd, true)).toContain("Bearer");
	expect(() => readSnapshot(join(dir, "outside"), DEFAULT_CONFIG, cwd)).toThrow(/outside/);
	expect(() => readSnapshot(join(cwd, ".env"), DEFAULT_CONFIG, cwd)).toThrow(/sensitive/);
	symlinkSync(path, join(cwd, "alias"));
	expect(canonicalPath(join(cwd, "alias"))).toBe(path);
	expect(() => readSnapshot(join(cwd, "alias"), DEFAULT_CONFIG, cwd, true)).toThrow();
});
it("builds complete changed hunks and explicitly rejects indivisible over-budget changes", () => {
	const { cwd, path } = fixture();
	const chunks = buildReviewChunks(
		[{ path, before: "const a = 1;\n", after: "const value = 1;\n" }],
		DEFAULT_CONFIG,
		cwd,
	);
	expect(chunks).toHaveLength(1);
	expect(chunks[0]!.input).toContain("const value = 1;");
	expect(chunks[0]!.files[0]!.changedRanges).toContainEqual([1, 1]);
	expect(buildReviewChunks([{ path, before: "same", after: "same" }], DEFAULT_CONFIG, cwd)).toEqual([]);
	expect(() =>
		buildReviewChunks([{ path, before: null, after: "x".repeat(64000) }], DEFAULT_CONFIG, cwd),
	).toThrow(/hunk/);
});
function separatedFileChanges() {
	const unchangedMiddle = Array.from({ length: 80 }, (_, index) => `const padding${index} = ${index};`).join(
		"\n",
	);
	return {
		path: "/repo/invoices.ts",
		before: `import { format } from "./format.js";\n${unchangedMiddle}\nformat(invoice);\n`,
		after: `import { formatInvoice } from "./format.js";\n${unchangedMiddle}\nformatInvoice(invoice);\n`,
	};
}

it("groups a changed import and its distant use into one same-file review", () => {
	const file = separatedFileChanges();
	const chunks = buildReviewChunks([file], DEFAULT_CONFIG, "/repo");
	expect(chunks).toHaveLength(1);
	const payload = JSON.parse(chunks[0]!.input);
	expect(payload.context).toEqual({
		kind: "changed-hunk-excerpts",
		includedChangedHunks: 2,
		totalChangedHunks: 2,
	});
	expect(payload.diff.match(/^@@ /gm)).toHaveLength(2);
	expect(payload.postEditExcerpt).toContain('1: import { formatInvoice } from "./format.js";');
	expect(payload.postEditExcerpt).toContain("82: formatInvoice(invoice);");
	expect(payload.postEditExcerpt).not.toContain("padding40");
	expect(chunks[0]!.files).toHaveLength(1);
	expect(chunks[0]!.files[0]!.visibleRanges).toHaveLength(2);
	expect(chunks[0]!.files[0]!.changedRanges).toContainEqual([1, 1]);
	expect(chunks[0]!.files[0]!.changedRanges).toContainEqual([82, 82]);
});

it("splits only at hunk boundaries when a same-file group exceeds the input allowance", () => {
	const file = separatedFileChanges();
	const grouped = buildReviewChunks([file], DEFAULT_CONFIG, "/repo");
	const maxInputChars = 14_000 + Math.ceil(grouped[0]!.input.length * 0.7);
	const chunks = buildReviewChunks([file], { ...DEFAULT_CONFIG, maxInputChars }, "/repo");
	expect(chunks).toHaveLength(2);
	for (const chunk of chunks) {
		expect(chunk.input.length).toBeLessThanOrEqual(maxInputChars - 14_000);
		const payload = JSON.parse(chunk.input);
		expect(payload.context).toEqual({
			kind: "changed-hunk-excerpts",
			includedChangedHunks: 1,
			totalChangedHunks: 2,
		});
		expect(payload.diff.match(/^@@ /gm)).toHaveLength(1);
	}
	const groupedDiff = JSON.parse(grouped[0]!.input).diff;
	const splitDiff = chunks.map((chunk) => JSON.parse(chunk.input).diff).join("\n");
	expect(splitDiff).toBe(groupedDiff);
	expect(chunks.flatMap((chunk) => chunk.files[0]!.visibleRanges)).toEqual(
		grouped[0]!.files[0]!.visibleRanges,
	);
	expect(chunks.flatMap((chunk) => chunk.files[0]!.changedRanges)).toEqual(
		grouped[0]!.files[0]!.changedRanges,
	);
});

it("allows proposals in both grouped hunks without allowing edits to omitted context", () => {
	const file = separatedFileChanges();
	const chunk = buildReviewChunks([file], DEFAULT_CONFIG, "/repo")[0]!;
	const verdict = {
		verdict: "needs_work",
		rationale: "Name the formatted representation",
		findings: [
			{
				file: file.path,
				line: 1,
				quote: "import { formatInvoice }",
				rule: "names",
				rationale: "Make the display format explicit",
			},
		],
		edits: [
			{
				file: file.path,
				oldText: 'import { formatInvoice } from "./format.js";',
				newText: 'import { formatInvoiceForDisplay } from "./format.js";',
			},
			{ file: file.path, oldText: "formatInvoice(invoice);", newText: "formatInvoiceForDisplay(invoice);" },
		],
	};
	const proposed = validateVerdict(verdict, chunk.files).proposed[file.path]!;
	expect(proposed).toContain("import { formatInvoiceForDisplay }");
	expect(proposed).toContain("formatInvoiceForDisplay(invoice);");
	expect(() =>
		validateVerdict(
			{
				...verdict,
				edits: [{ file: file.path, oldText: "const padding40 = 40;", newText: "const middleValue = 40;" }],
			},
			chunk.files,
		),
	).toThrow("Proposal uses unseen context");
});

it("keeps different files in separate groups and retains escaped Unicode exactly", () => {
	const file = separatedFileChanges();
	const second = {
		path: "/repo/labels.ts",
		before: null,
		after: 'const displayLabel = "café\\n\\\"quoted\\\"";\n',
	};
	const chunks = buildReviewChunks([file, second], DEFAULT_CONFIG, "/repo");
	expect(chunks).toHaveLength(2);
	expect(chunks.map((chunk) => JSON.parse(chunk.input).file)).toEqual([file.path, second.path]);
	expect(chunks[1]!.files[0]!.after).toBe(second.after);
	expect(JSON.parse(chunks[1]!.input).postEditExcerpt).toContain(second.after.trimEnd());
});

it("counts five corrections after initial rejection, and user choices are exact", () => {
	const { cwd, path } = fixture();
	const state = newCase(cwd, "p/m");
	state.files = [{ path, before: "", after: "bad" }];
	const verdict = {
		verdict: "needs_work" as const,
		rationale: "Rename",
		findings: [],
		edits: [{ file: path, oldText: "bad", newText: "good" }],
		proposed: { [path]: "good" },
	};
	recordVerdict(state, verdict, false);
	for (let i = 0; i < 4; i++) recordVerdict(state, verdict, true);
	expect(state.phase).toBe("correcting");
	recordVerdict(state, verdict, true);
	expect(state.phase).toBe("human");
	resolveCase(state, "continue", "keep local");
	expect(state.limit).toBe(10);
	expect(state.attempts).toBe(5);
	resolveCase(state, "proposed");
	expect(proposalApplied(state)).toBe(false);
	state.files[0]!.after = "good";
	expect(proposalApplied(state)).toBe(true);
});
it("persists private, hashed branch-local state and fails on missing/corrupt state", () => {
	const { dir, cwd, path } = fixture();
	const store = new CaseStore(join(dir, "agent"), cwd);
	const state = newCase(cwd, "p/m");
	state.files.push({ path, before: null, after: "text" });
	const ref = store.save(state);
	expect(store.load(ref)).toEqual(state);
	expect(statSync(join(store.root, `${ref.blob}.json`)).mode & 0o777).toBe(0o600);
	expect(latestReference([{ type: "custom", customType: STATE_ENTRY, data: ref }])).toEqual(ref);
	writeFileSync(join(store.root, `${ref.blob}.json`), "corrupt");
	expect(() => store.load(ref)).toThrow(/hash/);
	expect(() => new CaseStore(cwd, cwd)).toThrow(/outside/);
});
