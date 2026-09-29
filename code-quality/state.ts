import {
	constants,
	chmodSync,
	closeSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { canonicalPath, inside } from "./capture.js";
import { digest, VerdictSchema } from "./proposal.js";
import type { QualityCase } from "./case.js";

export const STATE_ENTRY = "code-quality:state:v1";
export interface StateReference {
	version: 1;
	id: string;
	blob: string;
	phase: string;
	attempts: number;
}
const Text = Type.String();
const OptionalText = Type.Optional(Text);
const Snapshot = Type.Object({
	path: Text,
	before: Type.Union([Text, Type.Null()]),
	after: Type.Union([Text, Type.Null()]),
});
const LspPosition = Type.Object({
	line: Type.Integer({ minimum: 0 }),
	character: Type.Integer({ minimum: 0 }),
});
const LspAssessmentSchema = Type.Object({
	findings: Type.Array(
		Type.Object({
			file: Text,
			serverId: Text,
			provider: OptionalText,
			severity: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
			code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
			message: Text,
			tags: Type.Optional(Type.Array(Type.Number())),
			range: Type.Object({ start: LspPosition, end: LspPosition }),
		}),
	),
	revision: Text,
	configuration: Text,
	workspaceRevision: Type.Integer({ minimum: 0 }),
	generation: Text,
});
const CaseSchema = Type.Object({
	version: Type.Literal(1),
	id: Text,
	cwd: Text,
	phase: Type.String({
		enum: ["captured", "reviewing", "correcting", "human", "paused", "applying", "closed"],
	}),
	files: Type.Array(Snapshot),
	attempts: Type.Integer({ minimum: 0 }),
	limit: Type.Integer({ minimum: 5 }),
	reviewed: Type.Boolean(),
	correctionPending: Type.Boolean(),
	reconsiderationPending: Type.Optional(Type.Boolean()),
	notes: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 20 }),
	authorized: Type.Array(Text),
	providerKey: Text,
	pendingPaths: Type.Array(Text),
	scope: Type.Array(Text),
	objection: OptionalText,
	lsp: Type.Optional(LspAssessmentSchema),
	lspWaived: Type.Optional(Type.Boolean()),
	lspRequired: Type.Optional(Type.Boolean()),
	reason: OptionalText,
	verdict: Type.Optional(
		Type.Object({
			...VerdictSchema.properties,
			rationale: Type.String({ maxLength: 4000 }),
			findings: Type.Array(VerdictSchema.properties.findings.items, { maxItems: 24 }),
			edits: Type.Array(VerdictSchema.properties.edits.items, { maxItems: 48 }),
			proposed: Type.Record(Type.String(), Text),
		}),
	),
	approvedTargets: Type.Optional(Type.Record(Type.String(), Type.String({ pattern: "^[a-f0-9]{64}$" }))),
	resolution: Type.Optional(
		Type.String({ enum: ["model_approved", "user_approved", "waived", "unchanged"] }),
	),
});

export class CaseStore {
	readonly root: string;
	constructor(
		agentDir: string,
		readonly cwd: string,
	) {
		this.root = resolve(canonicalPath(agentDir), "extensions", "code-quality", "cases");
		if (inside(canonicalPath(cwd), canonicalPath(this.root)))
			throw new Error("Quality runtime storage must be outside the workspace");
	}
	private ensureDirectory(): void {
		const missing: string[] = [];
		let path = this.root;
		for (;;) {
			try {
				const stat = lstatSync(path);
				if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe quality storage directory");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				missing.unshift(path);
			}
			const parent = dirname(path);
			if (parent === path) break;
			path = parent;
		}
		for (const dir of missing) mkdirSync(dir, { mode: 0o700 });
		chmodSync(this.root, 0o700);
	}
	save(state: QualityCase): StateReference {
		this.ensureDirectory();
		const text = JSON.stringify(state);
		if (Buffer.byteLength(text) > 80 * 1024 * 1024) throw new Error("Quality state exceeds storage budget");
		const blob = digest(text);
		const target = join(this.root, `${blob}.json`);
		try {
			if (lstatSync(target).isSymbolicLink()) throw new Error("Unsafe quality state file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const temp = join(this.root, `${randomUUID()}.tmp`);
		writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
		renameSync(temp, target);
		return { version: 1, id: state.id, blob, phase: state.phase, attempts: state.attempts };
	}
	load(ref: StateReference): QualityCase {
		if (!/^[a-f0-9]{64}$/.test(ref.blob)) throw new Error("Invalid quality state reference");
		this.ensureDirectory();
		const fd = openSync(join(this.root, `${ref.blob}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > 80 * 1024 * 1024) throw new Error("Invalid quality state file");
			const text = readFileSync(fd, "utf8");
			if (digest(text) !== ref.blob) throw new Error("Quality state hash mismatch");
			const value: unknown = JSON.parse(text);
			if (!Check(CaseSchema, value)) throw new Error("Invalid quality case state");
			const state = value as QualityCase;
			if (state.id !== ref.id || state.cwd !== this.cwd)
				throw new Error("Quality state belongs to another workspace/case");
			const paths = state.files.map((file) => file.path);
			if (
				new Set(paths).size !== paths.length ||
				[...paths, ...state.scope, ...state.authorized, ...state.pendingPaths].some(
					(path) => !isAbsolute(path),
				)
			)
				throw new Error("Invalid quality case paths");
			if (
				state.pendingPaths.some((path) => !paths.includes(path)) ||
				(state.phase === "applying" && !state.approvedTargets) ||
				(state.phase === "closed" && !state.resolution)
			)
				throw new Error("Incomplete quality case state");
			return state;
		} finally {
			closeSync(fd);
		}
	}
}
export function countRejectedReviews(entries: readonly unknown[]): number {
	const previousPhaseByCase = new Map<string, string>();
	let rejectionCount = 0;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const item = entry as { type?: string; customType?: string; data?: unknown };
		if (item.type !== "custom" || item.customType !== STATE_ENTRY) continue;
		const ref = item.data as Partial<StateReference> | undefined;
		if (ref?.version !== 1 || typeof ref.id !== "string" || typeof ref.phase !== "string") continue;
		const receivedRejection =
			previousPhaseByCase.get(ref.id) === "reviewing" &&
			(ref.phase === "correcting" || ref.phase === "human");
		if (receivedRejection) rejectionCount++;
		previousPhaseByCase.set(ref.id, ref.phase);
	}
	return rejectionCount;
}

export function latestReference(entries: readonly unknown[]): StateReference | undefined {
	for (const entry of [...entries].reverse()) {
		if (!entry || typeof entry !== "object") continue;
		const item = entry as { type?: string; customType?: string; data?: unknown };
		if (item.type !== "custom" || item.customType !== STATE_ENTRY) continue;
		const ref = item.data as StateReference;
		if (!ref || ref.version !== 1 || typeof ref.blob !== "string")
			throw new Error("Corrupt quality state reference");
		return ref;
	}
	return undefined;
}
