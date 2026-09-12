import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

const text = (maxLength = 4000) => Type.String({ minLength: 1, maxLength });
const list = <T extends TSchema>(items: T, maxItems = 64) => Type.Array(items, { maxItems });
const object = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const enumeration = <T extends string>(values: T[]) => Type.Unsafe<T>({ type: "string", enum: values });
export const BASELINES = ["security", "performance", "correctness", "style"] as const;
export const Severity = enumeration(["critical", "high", "medium", "low"]);
export const Side = enumeration(["old", "new"]);
export const Reading = list(text(1024), 32);
export const Predicate = object({ kind: enumeration(["path", "added", "removed"]), value: text(256) });
export const Specialist = object({
	id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
	name: text(80),
	focus: text(8000),
	requiredReading: Reading,
	always: Type.Boolean(),
	anyOf: list(list(Predicate, 8), 16),
});
export const ProfileDraft = object({
	name: text(120),
	summary: text(8000),
	requiredReading: Reading,
	baselineFocus: list(
		object({ id: enumeration([...BASELINES]), focus: text(8000), requiredReading: Reading }),
		4,
	),
	specialists: list(Specialist, 28),
	exclusions: list(object({ glob: text(256), reason: text(500) }), 64),
	freshnessSources: Reading,
});
export const ProfileSchema = object({
	schemaVersion: Type.Literal(1),
	contextVersion: Type.Literal(1),
	repoId: text(64),
	generatedAt: text(64),
	generationModel: text(512),
	sourceHashes: Type.Record(Type.String(), text(64)),
	draft: ProfileDraft,
});
export const ConfigSchema = object({
	schemaVersion: Type.Literal(1),
	provider: text(256),
	model: text(256),
	thinking: enumeration(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
	concurrency: Type.Integer({ minimum: 1, maximum: 16 }),
	timeoutMs: Type.Integer({ minimum: 1000, maximum: 600000 }),
	maxTurns: Type.Integer({ minimum: 1, maximum: 64 }),
	maxReviewers: Type.Integer({ minimum: 4, maximum: 32 }),
	maxJobs: Type.Integer({ minimum: 4, maximum: 256 }),
	maxInputBytes: Type.Integer({ minimum: 16000, maximum: 500000 }),
	maxFileBytes: Type.Integer({ minimum: 1024, maximum: 5242880 }),
	maxDiffBytes: Type.Integer({ minimum: 16000, maximum: 25000000 }),
	historyLimit: Type.Integer({ minimum: 1, maximum: 100 }),
});
export const Evidence = object({
	file: text(1024),
	side: Side,
	line: Type.Integer({ minimum: 1 }),
	quote: text(4000),
});
export const FindingSchema = object({
	title: text(160),
	severity: Severity,
	file: text(1024),
	side: Side,
	startLine: Type.Integer({ minimum: 1 }),
	endLine: Type.Integer({ minimum: 1 }),
	problem: text(),
	suggestion: text(8000),
	rationale: text(),
	evidence: list(Evidence, 8),
});
export const ReviewSubmission = object({
	complete: Type.Boolean(),
	limitations: list(text(1000), 20),
	findings: list(FindingSchema, 40),
});
export const VerificationSubmission = object({
	verdicts: list(
		object({
			id: text(120),
			verdict: enumeration(["confirmed", "corrected", "dropped", "inconclusive"]),
			reason: text(2000),
			corrected: Type.Optional(FindingSchema),
		}),
		10,
	),
});
export const ProposalSubmission = object({
	specialists: list(
		object({
			specialist: Specialist,
			reason: text(2000),
			files: Reading,
		}),
		4,
	),
});
export const DiscoverySubmission = object({
	notes: text(12000),
	sources: Reading,
	questions: list(
		object({
			question: text(1000),
			options: list(text(300), 4),
		}),
		4,
	),
});
export const ConsolidationSubmission = object({ groups: list(list(text(120), 128), 512) });

export type Draft = Static<typeof ProfileDraft>;
export type Profile = Static<typeof ProfileSchema>;
export type Config = Static<typeof ConfigSchema>;
export type Finding = Static<typeof FindingSchema>;
export type SpecialistDefinition = Static<typeof Specialist>;
export type Candidate = Finding & { id: string; reviewer: string };
export type ReviewResult = Static<typeof ReviewSubmission>;
export type Verdict = Static<typeof VerificationSubmission>["verdicts"][number];
export interface Repo {
	root: string;
	commonDir: string;
	id: string;
}
export type Scope =
	| { kind: "local" }
	| { kind: "commits"; count: number; committedOnly: boolean }
	| { kind: "base"; ref: string; committedOnly: boolean };
export interface Lens {
	id: string;
	name: string;
	focus: string;
	reading: string[];
	reason: string;
}
export interface LedgerEntry {
	id: string;
	verdict: Verdict["verdict"];
	reason: string;
}
export interface Report {
	version: 1;
	id: string;
	repoId: string;
	project: string;
	createdAt: string;
	scope: Scope;
	baseline: string | null;
	head: string | null;
	fingerprint: string;
	profileHash: string;
	promptHashes: Record<string, string>;
	model: string;
	status: "complete" | "incomplete" | "cancelled" | "no-changes";
	lenses: Lens[];
	declined: string[];
	clean: string[];
	issues: string[];
	omitted: Array<{ file: string; reason: string }>;
	changedFiles: number;
	findings: Candidate[];
	groups: string[][];
	ledger: LedgerEntry[];
	elapsedMs: number;
	usage: { input: number; output: number; cost: number };
	browser?: { decision: string; requestedIds: string[]; discussion: unknown[]; feedback: string };
}

export function validate<T extends TSchema>(schema: T, value: unknown): Static<T> {
	if (!Check(schema, value)) {
		const details = [...Errors(schema, value)]
			.slice(0, 5)
			.map((error) => `${error.instancePath}: ${error.message}`);
		throw new Error(`Invalid data: ${details.join("; ")}`);
	}
	return value as Static<T>;
}
