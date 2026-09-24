import { randomUUID } from "node:crypto";
import type { SnapshotFile } from "./capture.js";
import { digest, type ValidatedVerdict } from "./proposal.js";

export type Phase = "captured" | "reviewing" | "correcting" | "human" | "paused" | "applying" | "closed";
export interface QualityCase {
	version: 1;
	id: string;
	cwd: string;
	phase: Phase;
	files: SnapshotFile[];
	attempts: number;
	limit: number;
	reviewed: boolean;
	correctionPending: boolean;
	reconsiderationPending?: boolean;
	notes: string[];
	authorized: string[];
	providerKey: string;
	pendingPaths: string[];
	scope: string[];
	verdict?: ValidatedVerdict;
	objection?: string;
	reason?: string;
	approvedTargets?: Record<string, string>;
	resolution?: "model_approved" | "user_approved" | "waived" | "unchanged";
}
export function newCase(cwd: string, providerKey: string): QualityCase {
	return {
		version: 1,
		id: randomUUID(),
		cwd,
		providerKey,
		phase: "captured",
		files: [],
		attempts: 0,
		limit: 5,
		reviewed: false,
		correctionPending: false,
		notes: [],
		authorized: [],
		pendingPaths: [],
		scope: [],
	};
}
export function revision(state: QualityCase): string {
	return digest(
		JSON.stringify(
			state.files.map((file) => [file.path, digest(file.after)]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
		),
	);
}
export function recordVerdict(state: QualityCase, verdict: ValidatedVerdict, responseRound: boolean): void {
	if (responseRound && state.reviewed) state.attempts++;
	state.correctionPending = false;
	state.reconsiderationPending = false;
	state.reviewed = true;
	state.verdict = verdict;
	state.reason = undefined;
	if (verdict.verdict === "approved") {
		state.phase = "closed";
		state.resolution = "model_approved";
	} else state.phase = state.attempts >= state.limit ? "human" : "correcting";
}
export function requestReconsideration(state: QualityCase, objection?: string): void {
	if (state.attempts >= state.limit) {
		state.phase = "human";
		return;
	}
	state.objection = objection;
	state.reconsiderationPending = true;
	state.phase = "captured";
}

export function resolveCase(
	state: QualityCase,
	choice: "original" | "proposed" | "continue",
	note = "",
): void {
	if (note.trim() && (state.notes.length >= 20 || note.trim().length > 2000))
		throw new Error("Case note budget exceeded; shorten notes or resolve without another note");
	if (note.trim()) state.notes.push(note.trim());
	if (choice === "original") {
		state.phase = "closed";
		state.resolution = "user_approved";
	} else if (choice === "proposed") {
		if (!state.verdict?.edits.length) throw new Error("No validated reviewer proposal available");
		state.approvedTargets = Object.fromEntries(
			state.files.map((file) => [file.path, digest(state.verdict!.proposed[file.path] ?? file.after)]),
		);
		state.phase = "applying";
	} else {
		state.limit += 5;
		state.phase = "correcting";
	}
	state.objection = undefined;
}
export function proposalApplied(state: QualityCase): boolean {
	return (
		Boolean(state.approvedTargets) &&
		state.files.every((file) => state.approvedTargets![file.path] === digest(file.after))
	);
}
