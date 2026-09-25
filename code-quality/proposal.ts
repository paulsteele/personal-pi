import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Check } from "typebox/value";

export const digest = (text: string | null): string =>
	createHash("sha256")
		.update(text === null ? "absent:" : `text:${text}`)
		.digest("hex");
export interface ReviewFile {
	path: string;
	before: string | null;
	after: string;
	visibleRanges: Array<[number, number]>;
	changedRanges: Array<[number, number]>;
}
const bounded = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const FindingSchema = Type.Object(
	{
		file: bounded(4096),
		line: Type.Integer({ minimum: 1 }),
		quote: bounded(4000),
		rule: Type.String({
			enum: ["names", "structure", "comments", "tests", "contracts", "documents", "configuration"],
		}),
		rationale: Type.String({
			minLength: 1,
			maxLength: 1500,
			description:
				"Explain the violated human-readability preference. Correctness, unused symbols, formatting, lint, coverage, assertion exhaustiveness, performance, and security are outside scope.",
		}),
	},
	{ additionalProperties: false },
);
const EditSchema = Type.Object(
	{ file: bounded(4096), oldText: bounded(32_000), newText: Type.String({ maxLength: 32_000 }) },
	{ additionalProperties: false },
);
export const VerdictSchema = Type.Object(
	{
		verdict: Type.String({ enum: ["approved", "needs_work"] }),
		rationale: Type.String({
			minLength: 1,
			maxLength: 2000,
			description:
				"Summarize readability-preference compliance only; approval does not certify behavior or test coverage.",
		}),
		findings: Type.Array(FindingSchema, { maxItems: 12 }),
		edits: Type.Array(EditSchema, { maxItems: 24 }),
	},
	{ additionalProperties: false },
);
export interface Finding {
	file: string;
	line: number;
	quote: string;
	rule: string;
	rationale: string;
}
export interface ProposedEdit {
	file: string;
	oldText: string;
	newText: string;
}
export interface Verdict {
	verdict: "approved" | "needs_work";
	rationale: string;
	findings: Finding[];
	edits: ProposedEdit[];
}
export interface ValidatedVerdict extends Verdict {
	proposed: Record<string, string>;
}

export function applyExactEdits(text: string, edits: ProposedEdit[]): string {
	const matched = edits
		.map((edit) => {
			const start = text.indexOf(edit.oldText);
			if (!edit.oldText || start < 0 || text.indexOf(edit.oldText, start + 1) >= 0)
				throw new Error("Proposal must match uniquely and exactly");
			return { ...edit, start, end: start + edit.oldText.length };
		})
		.sort((a, b) => a.start - b.start);
	for (let i = 1; i < matched.length; i++)
		if (matched[i]!.start < matched[i - 1]!.end) throw new Error("Overlapping proposal edits");
	let result = text;
	for (const edit of matched.reverse())
		result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
	return result;
}

function lineRange(text: string, offset: number, length: number): [number, number] {
	const start = text.slice(0, offset).split("\n").length;
	return [start, start + text.slice(offset, offset + length).split("\n").length - 1];
}
function contained(range: [number, number], ranges: Array<[number, number]>): boolean {
	return ranges.some(([start, end]) => range[0] >= start && range[1] <= end);
}
export function validateVerdict(value: unknown, files: ReviewFile[]): ValidatedVerdict {
	if (!Check(VerdictSchema, value)) throw new Error("Invalid quality verdict schema");
	const verdict = value as Verdict;
	if (verdict.verdict === "approved" && (verdict.findings.length || verdict.edits.length))
		throw new Error("Approved verdict contains corrections");
	if (verdict.verdict === "needs_work" && (!verdict.findings.length || !verdict.edits.length))
		throw new Error("Needs-work requires findings and an applicable proposal");
	for (const finding of verdict.findings) {
		const file = files.find((file) => file.path === finding.file);
		const lines = file?.after.split("\n");
		if (!file || !lines || !contained([finding.line, finding.line], file.changedRanges))
			throw new Error(
				`Finding outside changed scope: ${JSON.stringify({ file: finding.file, line: finding.line, quote: finding.quote })}`,
			);
		if (
			!lines
				.slice(finding.line - 1)
				.join("\n")
				.startsWith(finding.quote) &&
			!lines[finding.line - 1]?.includes(finding.quote)
		)
			throw new Error("Finding quote does not match its line");
		if (!verdict.edits.some((edit) => edit.file === finding.file))
			throw new Error("Finding has no proposed correction");
	}
	const proposed: Record<string, string> = Object.create(null);
	for (const edit of verdict.edits) {
		const file = files.find((file) => file.path === edit.file);
		if (!file || !verdict.findings.some((finding) => finding.file === edit.file))
			throw new Error(`Proposal outside finding scope: ${JSON.stringify(edit.file)}`);
		const start = file.after.indexOf(edit.oldText);
		if (start < 0 || !contained(lineRange(file.after, start, edit.oldText.length), file.visibleRanges))
			throw new Error("Proposal uses unseen context");
	}
	for (const file of files) {
		const edits = verdict.edits.filter((edit) => edit.file === file.path);
		if (!edits.length) continue;
		const result = applyExactEdits(file.after, edits);
		if (result === file.after) throw new Error("Proposal makes no change");
		proposed[file.path] = result;
	}
	return { ...verdict, proposed };
}
