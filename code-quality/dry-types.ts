import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const line = Type.Integer({ minimum: 1 });
export const DryLineRangeSchema = Type.Tuple([line, line]);
export type DryLineRange = Static<typeof DryLineRangeSchema>;
export type QualityStageSource = "lsp" | "dry" | "readability";

export const DrySourceSchema = Type.Object({
	file: text(4096),
	range: DryLineRangeSchema,
	hash,
	text: text(262144),
	changedRanges: Type.Array(DryLineRangeSchema),
});
export type DrySource = Static<typeof DrySourceSchema>;
export const DryEvidenceSchema = Type.Object({
	id: hash,
	changed: DrySourceSchema,
	counterpart: DrySourceSchema,
	signals: Type.Array(text(160), { maxItems: 12 }),
	score: Type.Number({ minimum: 0 }),
});
export type DryEvidence = Static<typeof DryEvidenceSchema>;

export const DryFindingSchema = Type.Object(
	{
		pairId: hash,
		file: text(4096),
		line,
		quote: text(2000),
		counterpartFile: text(4096),
		counterpartRange: DryLineRangeSchema,
		counterpartQuote: text(2000),
		duplicatedKnowledge: text(1000),
		sharedOwnershipRationale: text(1500),
		correctionDirection: text(1500),
	},
	{ additionalProperties: false },
);
export type DryFinding = Static<typeof DryFindingSchema>;
export const DryVerdictSchema = Type.Object(
	{
		verdict: Type.Union([Type.Literal("approved"), Type.Literal("needs_work")]),
		rationale: text(2000),
		findings: Type.Array(DryFindingSchema, { maxItems: 3 }),
	},
	{ additionalProperties: false },
);
export type DryVerdict = Static<typeof DryVerdictSchema>;

function containsRange(outer: DryLineRange, inner: DryLineRange): boolean {
	return inner[0] <= inner[1] && inner[0] >= outer[0] && inner[1] <= outer[1];
}
function quotedAt(
	source: DrySource,
	quoteStartLine: number,
	quote: string,
	quoteRange = source.range,
): boolean {
	const lines = source.text.split("\n");
	const offset = quoteStartLine - source.range[0];
	const quoteEndLineInclusive = quoteStartLine + quote.split("\n").length - 1;
	return (
		containsRange(quoteRange, [quoteStartLine, quoteEndLineInclusive]) &&
		offset >= 0 &&
		(lines[offset]?.includes(quote) === true || lines.slice(offset).join("\n").startsWith(quote))
	);
}
export function validateDryVerdict(value: unknown, evidence: DryEvidence[]): DryVerdict {
	if (!Check(DryVerdictSchema, value)) {
		throw new Error("Invalid DRY verdict schema");
	}
	const verdict = value as DryVerdict;
	if ((verdict.verdict === "approved") !== (verdict.findings.length === 0)) {
		throw new Error("DRY rejection requires findings; approval cannot contain findings");
	}
	for (const finding of verdict.findings) {
		const pair = evidence.find((item) => item.id === finding.pairId);
		if (!pair || finding.file !== pair.changed.file || finding.counterpartFile !== pair.counterpart.file) {
			throw new Error("DRY finding does not cite a supplied pair");
		}
		const findingRange: DryLineRange = [finding.line, finding.line];
		const isInChangedRange = pair.changed.changedRanges.some((range) => containsRange(range, findingRange));
		const isInSuppliedSource = containsRange(pair.changed.range, findingRange);
		const quoteMatchesChangedSource = quotedAt(pair.changed, finding.line, finding.quote);
		if (!isInChangedRange || !isInSuppliedSource || !quoteMatchesChangedSource) {
			throw new Error("DRY finding must quote an eligible changed line");
		}
		if (
			!containsRange(pair.counterpart.range, finding.counterpartRange) ||
			!quotedAt(
				pair.counterpart,
				finding.counterpartRange[0],
				finding.counterpartQuote,
				finding.counterpartRange,
			)
		) {
			throw new Error("DRY counterpart citation does not match supplied source");
		}
	}
	return verdict;
}

export const DryCoverageSchema = Type.Object({
	file: text(4096),
	ranges: Type.Array(DryLineRangeSchema),
	outcome: Type.Union([
		Type.Literal("reviewed"),
		Type.Literal("no_candidates"),
		Type.Literal("unsupported"),
		Type.Literal("outside-index"),
		Type.Literal("waived"),
		Type.Literal("incomplete"),
	]),
	retrieved: Type.Integer({ minimum: 0 }),
	selected: Type.Integer({ minimum: 0 }),
	reason: Type.Optional(text(2000)),
});
export type DryCoverage = Static<typeof DryCoverageSchema>;
export const DryAssessmentSchema = Type.Object({
	verdict: Type.Optional(
		Type.Object({
			...DryVerdictSchema.properties,
			findings: Type.Array(DryFindingSchema, { maxItems: 24 }),
		}),
	),
	evidence: Type.Array(DryEvidenceSchema),
	coverage: Type.Array(DryCoverageSchema),
	revision: hash,
	manifestRevision: hash,
	configuration: hash,
	generation: text(240),
	providerKey: text(240),
});
export type DryAssessment = Static<typeof DryAssessmentSchema>;

export interface DryWindow {
	range: DryLineRange;
	features: string[];
}
export interface DryIndexedFile {
	path: string;
	hash: string;
	format: string;
	bytes: number;
	lines: number;
	windows: DryWindow[];
	suppressed: boolean;
}
export interface DryClone {
	snippet: { path: string; range: DryLineRange };
	counterpart: { path: string; range: DryLineRange };
	kind: "exact" | "renamed" | "similar";
	method?: "gap" | "ast";
	tokens: number;
	similarity?: number;
}
export interface DryManifest {
	version: 1;
	revision: string;
	files: Array<Omit<DryIndexedFile, "windows">>;
	excluded: Array<{ path: string; reason: string }>;
	truncated: boolean;
	bytes: number;
}
export interface DryReport {
	version: 1;
	manifestRevision: string;
	cloneCounts: { exact: number; renamed: number; gap: number; ast: number };
	analyzedFiles: number;
	formats: Array<{ name: string; files: number }>;
	scanDurationMs: number;
}
export type DryToolPhase = "unavailable" | "validating" | "ready" | "off";
export type DryScanPhase = "idle" | "scanning" | "ready" | "limited" | "unavailable" | "off";
export interface DryStatus {
	toolPhase: DryToolPhase;
	scanPhase: DryScanPhase;
	version?: string;
	executable?: string;
	scope?: string;
	revision?: string;
	files: number;
	windows: number;
	bytes: number;
	excluded: number;
	formatCount: number;
	astFormatCount: number;
	cloneCounts: { exact: number; renamed: number; gap: number; ast: number };
	lastScanAt?: number;
	scanDurationMs?: number;
	formats?: Array<{ name: string; files: number }>;
	latest?: {
		outcome: string;
		retrieved: number;
		selected: number;
		requests: number;
		latencyMs: number;
		inputTokens: number;
		outputTokens: number;
	};
	reason?: string;
}
export function emptyDryStatus(): DryStatus {
	return {
		toolPhase: "unavailable",
		scanPhase: "idle",
		files: 0,
		windows: 0,
		bytes: 0,
		excluded: 0,
		formatCount: 0,
		astFormatCount: 0,
		cloneCounts: { exact: 0, renamed: 0, gap: 0, ast: 0 },
	};
}
