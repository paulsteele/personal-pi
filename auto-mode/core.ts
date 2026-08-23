/**
 * Pure decision logic for the auto-mode authorizer link.
 *
 * No Pi runtime, no model, no filesystem — everything here is deterministic
 * and unit-testable. The module encodes one invariant above all others:
 *
 *   **Every uncertainty resolves to `defer`.**
 *
 * `defer` falls through to the human prompt, so a bug, a timeout, a malformed
 * reply, or an unrecognized shape can only ever cause *more* prompting. The
 * only paths that produce `allow` are an explicit, well-formed, in-bounds
 * model verdict while the runtime toggle is on.
 */

/** The verdict vocabulary of pi-permission-system's authorizer seam. */
export type VerdictKind = "allow" | "deny" | "defer";

export interface Verdict {
	readonly kind: VerdictKind;
	readonly reason?: string;
}

export const DEFER: Verdict = { kind: "defer" };

/**
 * Surfaces on which pi-permission-system caps a link's `allow` down to
 * `defer` (`src/authority/delegation-envelope.ts`).
 *
 * Mirrored here so we can short-circuit *before* paying for a model call on a
 * verdict that would be discarded anyway. This is a performance and cost
 * optimization layered on top of the real enforcement, never a replacement
 * for it: the chain owner caps these regardless of what we return.
 */
export const CAPPED_SURFACES: ReadonlySet<string> = new Set(["external_directory", "path"]);

/** Why a review did not produce a decisive verdict. Recorded to the review log. */
export type DeferReason =
	| "toggle-off"
	| "config-unusable"
	| "capped-surface"
	| "unknown-surface"
	| "model-unresolved"
	| "auth-failed"
	| "timeout"
	| "call-failed"
	| "no-tool-call"
	| "unparseable-reply"
	| "non-decisive-verdict";

/** One recorded review, for the review log and the Atelier panel. */
export interface DecisionRecord {
	readonly requestId: string;
	readonly surface: string;
	readonly value: string;
	readonly verdict: VerdictKind;
	readonly reason: string | null;
	readonly deferReason: DeferReason | null;
	readonly modelCalled: boolean;
	readonly latencyMs: number | null;
	readonly cached: boolean;
	readonly at: number;
}

/** Maximum characters of a model-supplied reason we pass to the agent. */
export const MAX_REASON_CHARS = 500;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

/**
 * Strip control sequences and bound a model-authored string.
 *
 * The reason is rendered into a TUI and fed back to the agent, so a model that
 * emits ANSI escapes or a megabyte of text must not corrupt the display or the
 * next prompt.
 */
export function sanitizeReason(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.replace(ANSI_ESCAPE, "").replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
	if (cleaned === "") return undefined;
	return cleaned.length > MAX_REASON_CHARS ? `${cleaned.slice(0, MAX_REASON_CHARS - 1)}…` : cleaned;
}

/**
 * Determine the gate surface an ask fired on.
 *
 * Prefers the gate-authoritative `accessIntent.surface` over the display
 * `surface`, matching how pi-permission-system's own delegation envelope
 * decides. Returns `undefined` when neither is a usable string, which callers
 * must treat as fail-safe (defer).
 */
export function resolveGateSurface(details: {
	accessIntent?: { surface?: unknown } | undefined;
	surface?: unknown;
	payload?: { request?: { surface?: unknown } } | undefined;
}): string | undefined {
	const candidates = [details.accessIntent?.surface, details.payload?.request?.surface, details.surface];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
	}
	return undefined;
}

/** Whether a link's `allow` on this surface would be capped to `defer` upstream. */
export function isCappedSurface(surface: string | undefined): boolean {
	// Fail safe: an indeterminate surface is treated as capped, matching
	// pi-permission-system's own `isExcludedSurface`.
	return surface === undefined || CAPPED_SURFACES.has(surface);
}

/** The raw shape a classifier reply is expected to take. */
export interface RawVerdict {
	verdict?: unknown;
	reason?: unknown;
}

export interface ParsedVerdict {
	readonly verdict: Verdict;
	readonly deferReason: DeferReason | null;
}

/**
 * Convert a model reply into a verdict.
 *
 * A `deny` keeps its teaching reason so the agent can self-correct. Anything
 * that is not an exact, recognized decisive verdict becomes `defer` — including
 * an explicit `"defer"`, a misspelling, a non-string, or a missing field.
 */
export function parseVerdict(raw: RawVerdict | null | undefined): ParsedVerdict {
	if (!raw || typeof raw !== "object") {
		return { verdict: DEFER, deferReason: "unparseable-reply" };
	}
	const kind = typeof raw.verdict === "string" ? raw.verdict.trim().toLowerCase() : "";
	if (kind === "allow") {
		return { verdict: { kind: "allow" }, deferReason: null };
	}
	if (kind === "deny") {
		const reason = sanitizeReason(raw.reason);
		return { verdict: reason ? { kind: "deny", reason } : { kind: "deny" }, deferReason: null };
	}
	if (kind === "defer") {
		return { verdict: DEFER, deferReason: "non-decisive-verdict" };
	}
	return { verdict: DEFER, deferReason: "unparseable-reply" };
}

/**
 * Apply the local capped-surface guard to a verdict.
 *
 * Mirrors pi-permission-system's bounded-delegation checkpoint: an `allow` on a
 * capped surface becomes `defer`. `deny` and `defer` pass through untouched,
 * because tightening is always permitted.
 */
export function applyCap(verdict: Verdict, surface: string | undefined): ParsedVerdict {
	if (verdict.kind === "allow" && isCappedSurface(surface)) {
		return { verdict: DEFER, deferReason: "capped-surface" };
	}
	return { verdict, deferReason: null };
}

/**
 * Key identifying a review for turn-scoped caching.
 *
 * Length-prefixed rather than delimiter-joined. A plain separator is forgeable:
 * with `a\0b` as a joiner, the pair (`bash`, `a\0b`) and the pair (`bash\0a`,
 * `b`) produce the same string, so a crafted command value could collide with
 * an unrelated entry and inherit its cached `allow`. Encoding each field's
 * length makes the key injective for any input.
 */
export function cacheKey(surface: string, value: string, agentName: string | null): string {
	const agent = agentName ?? "";
	return `${agent.length}:${agent}|${surface.length}:${surface}|${value.length}:${value}`;
}

/**
 * Turn-scoped verdict cache.
 *
 * Claude Code caches classifier verdicts within a turn and drops them whenever
 * the mode or the rules change. Without this, a loop that runs the same command
 * N times in one turn pays N classifier calls. Only decisive verdicts are
 * cached: a `defer` must be re-evaluated, because deferring means the human
 * already saw it and their answer is not ours to remember.
 */
export class VerdictCache {
	private entries = new Map<string, Verdict>();

	get(key: string): Verdict | undefined {
		return this.entries.get(key);
	}

	set(key: string, verdict: Verdict): void {
		if (verdict.kind === "defer") return;
		this.entries.set(key, verdict);
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}

/**
 * Bounded, newest-first log of reviews for the Atelier panel.
 *
 * Bounded because it is rendered into a sidebar and held for the life of a
 * session; an unbounded list would grow with every tool call.
 */
export class DecisionLog {
	private records: DecisionRecord[] = [];
	private allowed = 0;
	private denied = 0;
	private escalated = 0;

	constructor(private readonly limit: number) {}

	add(record: DecisionRecord): void {
		if (record.verdict === "allow") this.allowed += 1;
		else if (record.verdict === "deny") this.denied += 1;
		// A defer is a real outcome the operator experiences as a prompt, so it
		// is counted rather than silently dropped. Without this the panel reads
		// "allowed 0 denied 0" while auto mode is armed and still interrupting.
		else this.escalated += 1;
		this.records.unshift(record);
		if (this.records.length > this.limit) this.records.length = this.limit;
	}

	/** Newest-first records, at most `count`. */
	recent(count: number): readonly DecisionRecord[] {
		return this.records.slice(0, Math.max(0, count));
	}

	get counts(): { allowed: number; denied: number; escalated: number } {
		return { allowed: this.allowed, denied: this.denied, escalated: this.escalated };
	}

	clear(): void {
		this.records = [];
		this.allowed = 0;
		this.denied = 0;
		this.escalated = 0;
	}
}

/** Everything the panel/footer needs to render, with no Pi or Atelier types. */
export interface AutoModeSnapshot {
	readonly enabled: boolean;
	readonly usable: boolean;
	/** Classifier selected for this session, rendered in the sidebar. */
	readonly modelId: string;
	readonly allowed: number;
	readonly denied: number;
	/** Asks auto mode could not decide, which reached the operator as a prompt. */
	readonly escalated: number;
	readonly recent: readonly DecisionRecord[];
}

/** Compact one-line label for the footer, e.g. `⏵⏵ auto 12/1`. */
export function footerLabel(snapshot: AutoModeSnapshot): string {
	if (!snapshot.enabled) return "⏸ manual";
	const counts = snapshot.allowed + snapshot.denied > 0 ? ` ${snapshot.allowed}/${snapshot.denied}` : "";
	return `⏵⏵ auto${counts}`;
}

/** Bound one decision to a single readable line for the panel. */
export function describeDecision(record: DecisionRecord, maxChars = 60): string {
	const mark = record.verdict === "allow" ? "✓" : record.verdict === "deny" ? "✗" : "→";
	const value = record.value.replace(/\s+/g, " ").trim();
	const text = `${mark} ${record.surface}: ${value}`;
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * Operator-facing explanation of why an ask reached them despite auto mode.
 *
 * `capped-surface` means the local Bun patch is missing or stale: this setup
 * explicitly delegates `path` and `external_directory` to the named `auto`
 * link. If upstream's stock envelope still caps the verdict, the patch was not
 * applied (usually after an unreviewed dependency upgrade).
 */
export function explainDefer(reason: DeferReason | null): string | null {
	switch (reason) {
		case "capped-surface":
			return "auto authority patch missing or stale";
		case "config-unusable":
			return "no classifier model configured";
		case "model-unresolved":
			return "classifier model not found";
		case "auth-failed":
			return "classifier auth unavailable";
		case "timeout":
			return "classifier timed out";
		case "call-failed":
			return "classifier call failed";
		case "no-tool-call":
		case "unparseable-reply":
			return "classifier reply unusable";
		case "non-decisive-verdict":
			return "classifier was unsure";
		case "unknown-surface":
			return "unrecognized request shape";
		case "toggle-off":
			return null;
		default:
			return null;
	}
}
