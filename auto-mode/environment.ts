/**
 * The plugin-owned environment check.
 *
 * pi-permission-system structurally forbids a chain link from granting
 * `external_directory` or `path` access: its bounded-delegation checkpoint
 * downgrades such an `allow` to `defer`. That cap is not configurable and
 * cannot be lifted from a plugin.
 *
 * Auto mode therefore does not try to *grant* those surfaces through the
 * chain. It arbitrates them one step earlier, at Pi's `tool_call` event, which
 * runs before the permission gates. While auto mode is armed, this module
 * decides whether a tool call's filesystem reach is acceptable; when it is,
 * the call proceeds and the downstream `external_directory` prompt is
 * pre-empted. When auto mode is off, this module is inert and the operator's
 * configured rules apply verbatim.
 *
 * Nothing here writes configuration. The permission-system config is read-only
 * to this extension, so turning auto mode off restores the operator's exact
 * policy with no reconciliation step and no persistent side effects.
 */

import { dirname, isAbsolute, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/** Why an environment decision came out the way it did. Recorded, not guessed. */
export type EnvironmentReason =
	| "no-paths"
	| "inside-cwd"
	| "trusted-root"
	| "outside-environment"
	| "sensitive-path";

export interface EnvironmentDecision {
	/** True when every referenced path is inside the trusted environment. */
	readonly inBounds: boolean;
	readonly reason: EnvironmentReason;
	/** The paths that fell outside, for the prompt and the log. */
	readonly offending: readonly string[];
}

/**
 * Path shapes that must never be silently approved, regardless of location.
 *
 * These mirror the intent of the operator's own `path` deny rules. Auto mode
 * pre-empts the `external_directory` gate, so without this a secret file under
 * a trusted root would bypass the prompt the operator configured. Matching is
 * on the final segment and on directory components, so `.env.local` and
 * `~/.ssh/id_rsa` are both caught.
 */
const SENSITIVE_SEGMENTS: readonly RegExp[] = [
	/^\.env(\..+)?$/i,
	/^\.netrc$/i,
	/^\.npmrc$/i,
	/^\.pypirc$/i,
	/^id_[a-z0-9]+$/i,
	/^.*\.pem$/i,
	/^.*\.p12$/i,
	/^.*\.pfx$/i,
	/^credentials$/i,
];

const SENSITIVE_DIRECTORIES: readonly string[] = [".ssh", ".gnupg", ".aws", ".kube", ".docker"];

/** An explicitly non-secret exception that would otherwise match. */
const SENSITIVE_EXCEPTIONS: readonly RegExp[] = [/^\.env\.example$/i, /^\.env\.sample$/i, /^\.env\.template$/i];

/**
 * Canonicalize a path, resolving symlinks through the nearest existing
 * ancestor.
 *
 * A plain `realpathSync` throws on a path that does not exist yet and returns
 * it unresolved, which silently breaks containment checks: on macOS `/tmp` is
 * a symlink to `/private/tmp`, so a not-yet-created `/tmp/out.txt` would stay
 * `/tmp/out.txt` while the trusted root canonicalized to `/private/tmp` — and
 * the two would never compare equal. Walking up to an existing ancestor and
 * re-joining the missing tail makes both sides land in the same namespace.
 *
 * This matters for correctness in both directions: it is what lets a declared
 * trusted root actually match, and what stops a symlink from disguising an
 * out-of-bounds target as an in-bounds one.
 */
export function canonical(path: string): string {
	let current = resolve(path);
	const missing: string[] = [];
	for (;;) {
		try {
			return resolve(realpathSync(current), ...missing);
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(path);
			missing.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
			current = parent;
		}
	}
}

/** True when `child` is `parent` or sits beneath it, after canonicalization. */
export function isWithin(parent: string, child: string): boolean {
	const p = canonical(parent);
	const c = canonical(child);
	if (p === c) return true;
	return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** True when a path's own shape marks it as secret-bearing. */
export function isSensitivePath(path: string): boolean {
	const segments = canonical(path).split(sep).filter(Boolean);
	const leaf = segments[segments.length - 1] ?? "";
	if (SENSITIVE_EXCEPTIONS.some((pattern) => pattern.test(leaf))) return false;
	if (SENSITIVE_SEGMENTS.some((pattern) => pattern.test(leaf))) return true;
	return segments.some((segment) => SENSITIVE_DIRECTORIES.includes(segment.toLowerCase()));
}

export interface EnvironmentPolicy {
	/** The session working directory; always in bounds. */
	readonly cwd: string;
	/**
	 * Additional roots the operator declared trusted for auto mode.
	 *
	 * Declared in this extension's own config, never in the permission-system
	 * config, so the operator's manual-mode policy is untouched.
	 */
	readonly trustedRoots: readonly string[];
}

/**
 * Decide whether a set of referenced paths is inside the trusted environment.
 *
 * Fail-safe by construction: an empty policy trusts only `cwd`, an
 * unresolvable path is treated as outside, and any sensitive path is out of
 * bounds even under a trusted root.
 */
export function evaluatePaths(paths: readonly string[], policy: EnvironmentPolicy): EnvironmentDecision {
	const candidates = paths.filter((path) => typeof path === "string" && path.trim() !== "");
	if (candidates.length === 0) {
		return { inBounds: true, reason: "no-paths", offending: [] };
	}

	const sensitive = candidates.filter((path) => isSensitivePath(path));
	if (sensitive.length > 0) {
		// A secret is never in bounds, even inside cwd: the operator's own
		// `path` rules deny these, and auto mode must not undercut that.
		return { inBounds: false, reason: "sensitive-path", offending: [...new Set(sensitive)] };
	}

	const roots = [policy.cwd, ...policy.trustedRoots].filter((root) => root.trim() !== "");
	const outside = candidates.filter((path) => !roots.some((root) => isWithin(root, path)));

	if (outside.length > 0) {
		return { inBounds: false, reason: "outside-environment", offending: [...new Set(outside)] };
	}

	const allInsideCwd = candidates.every((path) => isWithin(policy.cwd, path));
	return { inBounds: true, reason: allInsideCwd ? "inside-cwd" : "trusted-root", offending: [] };
}

/**
 * Extract the filesystem paths a tool call will touch.
 *
 * Mirrors pi-permission-system's own conventions (`src/access-intent/
 * tool-input-path.ts`): built-in path tools carry `input.path`, MCP carries
 * `input.arguments.path`, and `bash` is handled separately because its paths
 * live inside a command string rather than an argument.
 */
export function toolCallPaths(toolName: string, input: unknown): readonly string[] {
	if (typeof input !== "object" || input === null) return [];
	const record = input as Record<string, unknown>;
	if (toolName === "bash") return [];

	const direct = record.path;
	if (typeof direct === "string" && direct.trim() !== "") return [direct];

	if (toolName === "mcp") {
		const args = record.arguments;
		if (typeof args === "object" && args !== null) {
			const nested = (args as Record<string, unknown>).path;
			if (typeof nested === "string" && nested.trim() !== "") return [nested];
		}
	}
	return [];
}

/**
 * Absolute-looking path tokens in a shell command.
 *
 * Intentionally conservative and used only to *withhold* pre-emption, never to
 * grant it: this is a coarse screen that decides whether auto mode should stay
 * out of the way and let the real gate run. The permission system remains the
 * authority on what bash actually touches — its parser understands quoting,
 * substitution, and expansion, and this deliberately does not try to.
 */
export function bashPathTokens(command: string, cwd: string): readonly string[] {
	if (typeof command !== "string" || command.trim() === "") return [];
	const tokens = new Set<string>();

	// Absolute paths, and ~ references, appearing anywhere in the command.
	for (const match of command.matchAll(/(?<![\w$])(~\/[^\s"';|&)]*|\/[^\s"';|&)]*)/g)) {
		const raw = match[1];
		if (!raw) continue;
		const expanded = raw.startsWith("~/") ? resolve(process.env.HOME ?? "", raw.slice(2)) : raw;
		if (!isAbsolute(expanded)) continue;
		// A lone "/" or a flag-like token is noise, not a path reference.
		if (expanded === "/" || expanded.length < 2) continue;
		if (!isWithin(cwd, expanded)) tokens.add(expanded);
	}
	return [...tokens];
}

/** Human-readable explanation for a prompt or log entry. */
export function describeEnvironmentDecision(decision: EnvironmentDecision): string {
	switch (decision.reason) {
		case "sensitive-path":
			return `references a secret-bearing path (${decision.offending.join(", ")})`;
		case "outside-environment":
			return `references paths outside the trusted environment (${decision.offending.join(", ")})`;
		case "trusted-root":
			return "within a trusted root";
		case "inside-cwd":
			return "within the working directory";
		case "no-paths":
			return "references no filesystem paths";
	}
}
