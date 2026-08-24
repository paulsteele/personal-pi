/**
 * Layered configuration for the auto-mode authorizer link.
 *
 * Read-only by contract: this module never writes the permission-system
 * config. Auto mode's authority comes from the runtime toggle plus the
 * operator naming `auto` in `authorizerChain`, never from rewriting policy.
 *
 * Global config lives at `<agentDir>/extensions/auto-mode/config.json`.
 * A project override at `<cwd>/.pi/extensions/auto-mode/config.json` is
 * merged over it, and only when the caller reports the project as trusted —
 * an untrusted repository must not be able to point the classifier at a
 * model it controls or change future manual-mode policy hints.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EXTENSION_ID = "auto-mode";

/**
 * Reserved manual-mode policy hints.
 *
 * Auto mode intentionally ignores these: its classifier judges the exact
 * permission-system evidence case by case, and an unlisted path is not unsafe
 * merely because it is unlisted. These fields are retained for compatibility
 * and for a future manual-mode policy layer, where deterministic trusted roots
 * can reduce prompts without influencing model judgment.
 */
export interface AutoModeEnvironment {
	readonly trustedRoots: readonly string[];
	readonly trustedRemotes: readonly string[];
	readonly trustedDomains: readonly string[];
}

export interface AutoModeConfig {
	/** Model provider id, resolved against Pi's model registry. */
	readonly provider: string;
	/** Model id within that provider. */
	readonly model: string;
	/** Per-review wall-clock budget; a timeout defers. */
	readonly timeoutMs: number;
	/** Whether a fresh session starts with auto mode armed. */
	readonly enabledByDefault: boolean;
	/** Maximum decisions retained for the Atelier panel. */
	readonly maxDecisionLog: number;
	/** Recent user turns passed to the classifier as stated-boundary context. */
	readonly contextUserTurns: number;
	readonly environment: AutoModeEnvironment;
}

export const DEFAULT_CONFIG: AutoModeConfig = {
	provider: "",
	model: "",
	timeoutMs: 5000,
	enabledByDefault: false,
	maxDecisionLog: 50,
	contextUserTurns: 3,
	environment: { trustedRoots: [], trustedRemotes: [], trustedDomains: [] },
};

/** Bounds that keep a malformed or hostile config from degrading the gate. */
const LIMITS = {
	timeoutMs: { min: 250, max: 60_000 },
	maxDecisionLog: { min: 1, max: 500 },
	contextUserTurns: { min: 0, max: 20 },
	maxEnvironmentEntries: 100,
	maxEnvironmentEntryChars: 200,
} as const;

export interface ConfigLoadResult {
	readonly config: AutoModeConfig;
	/** Human-readable problems; surfaced once via `ctx.ui.notify`. */
	readonly issues: readonly string[];
	/** True when a provider/model pair is present, so a call can be attempted. */
	readonly usable: boolean;
}

export function globalConfigPath(agentDir: string): string {
	return join(agentDir, "extensions", EXTENSION_ID, "config.json");
}

function projectConfigPath(cwd: string, configDirName: string): string {
	return join(cwd, configDirName, "extensions", EXTENSION_ID, "config.json");
}

/**
 * Read one JSON config file.
 *
 * A missing file is not an issue (the common case). A malformed one is: it
 * means the operator intended configuration that is not taking effect, and
 * silently defaulting would hide that.
 */
function readConfigFile(path: string): { raw: Record<string, unknown>; issue?: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") return { raw: {} };
		return { raw: {}, issue: `auto-mode: cannot read '${path}': ${describeError(error)}` };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { raw: {}, issue: `auto-mode: '${path}' must contain a JSON object` };
		}
		return { raw: parsed as Record<string, unknown> };
	} catch (error) {
		return { raw: {}, issue: `auto-mode: '${path}' is not valid JSON: ${describeError(error)}` };
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readString(raw: Record<string, unknown>, key: string, issues: string[]): string | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		issues.push(`auto-mode: '${key}' must be a non-empty string`);
		return undefined;
	}
	return value.trim();
}

function readBoolean(raw: Record<string, unknown>, key: string, issues: string[]): boolean | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		issues.push(`auto-mode: '${key}' must be a boolean`);
		return undefined;
	}
	return value;
}

function readInteger(
	raw: Record<string, unknown>,
	key: string,
	bounds: { min: number; max: number },
	issues: string[],
): number | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
		issues.push(`auto-mode: '${key}' must be an integer`);
		return undefined;
	}
	if (value < bounds.min || value > bounds.max) {
		issues.push(`auto-mode: '${key}' must be between ${bounds.min} and ${bounds.max}`);
		return undefined;
	}
	return value;
}

/** Read a bounded list of short strings, dropping anything malformed. */
function readStringList(value: unknown, key: string, issues: string[]): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		issues.push(`auto-mode: '${key}' must be an array of strings`);
		return undefined;
	}
	const out: string[] = [];
	for (const entry of value) {
		if (out.length >= LIMITS.maxEnvironmentEntries) break;
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (trimmed === "" || trimmed.length > LIMITS.maxEnvironmentEntryChars) continue;
		out.push(trimmed);
	}
	return out;
}

function readEnvironment(
	raw: Record<string, unknown>,
	issues: string[],
	base: AutoModeEnvironment,
): AutoModeEnvironment {
	const value = raw.environment;
	if (value === undefined) return base;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		issues.push("auto-mode: 'environment' must be an object");
		return base;
	}
	const record = value as Record<string, unknown>;
	return {
		trustedRoots: readStringList(record.trustedRoots, "environment.trustedRoots", issues) ?? base.trustedRoots,
		trustedRemotes: readStringList(record.trustedRemotes, "environment.trustedRemotes", issues) ?? base.trustedRemotes,
		trustedDomains: readStringList(record.trustedDomains, "environment.trustedDomains", issues) ?? base.trustedDomains,
	};
}

/** Apply one raw config layer over an accumulated config. */
export function applyConfigLayer(
	base: AutoModeConfig,
	raw: Record<string, unknown>,
	issues: string[],
): AutoModeConfig {
	return {
		provider: readString(raw, "provider", issues) ?? base.provider,
		model: readString(raw, "model", issues) ?? base.model,
		timeoutMs: readInteger(raw, "timeoutMs", LIMITS.timeoutMs, issues) ?? base.timeoutMs,
		enabledByDefault: readBoolean(raw, "enabledByDefault", issues) ?? base.enabledByDefault,
		maxDecisionLog: readInteger(raw, "maxDecisionLog", LIMITS.maxDecisionLog, issues) ?? base.maxDecisionLog,
		contextUserTurns: readInteger(raw, "contextUserTurns", LIMITS.contextUserTurns, issues) ?? base.contextUserTurns,
		environment: readEnvironment(raw, issues, base.environment),
	};
}

/** Update global auto-mode config without dropping unknown/future fields. */
function updateGlobalConfig(agentDir: string, fields: Record<string, unknown>): void {
	const path = globalConfigPath(agentDir);
	const existing = readConfigFile(path);
	if (existing.issue && Object.keys(existing.raw).length === 0) {
		throw new Error(existing.issue);
	}
	const next = { ...existing.raw, ...fields };
	const temp = `${path}.tmp`;
	try {
		mkdirSync(join(agentDir, "extensions", EXTENSION_ID), { recursive: true });
		writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
		renameSync(temp, path);
	} catch (error) {
		try {
			rmSync(temp, { force: true });
		} catch {
			// Preserve the original failure.
		}
		throw error;
	}
}

/** Persist a classifier selection to global auto-mode config atomically. */
export function saveAutoModeModel(agentDir: string, provider: string, model: string): void {
	updateGlobalConfig(agentDir, { provider, model });
}

/** Persist the operator's mode choice for subsequent sessions and reloads. */
export function saveAutoModeEnabled(agentDir: string, enabled: boolean): void {
	updateGlobalConfig(agentDir, { enabledByDefault: enabled });
}

export interface LoadConfigOptions {
	readonly agentDir: string;
	readonly cwd?: string;
	readonly configDirName: string;
	/** Project scope is withheld unless the project is trusted. */
	readonly projectTrusted: boolean;
}

/**
 * Load global config, then merge a trusted project override over it.
 *
 * Never throws: a broken config degrades to defaults plus reported issues, and
 * an unusable result simply means the link defers everything.
 */
export function loadAutoModeConfig(options: LoadConfigOptions): ConfigLoadResult {
	const issues: string[] = [];
	let config = DEFAULT_CONFIG;

	const global = readConfigFile(globalConfigPath(options.agentDir));
	if (global.issue) issues.push(global.issue);
	config = applyConfigLayer(config, global.raw, issues);
	const persistedEnabled = config.enabledByDefault;

	if (options.projectTrusted && options.cwd) {
		const project = readConfigFile(projectConfigPath(options.cwd, options.configDirName));
		if (project.issue) issues.push(project.issue);
		config = {
			...applyConfigLayer(config, project.raw, issues),
			// Mode is an operator-level persisted toggle. A repository may tune its
			// classifier, but it cannot silently arm or disarm auto mode.
			enabledByDefault: persistedEnabled,
		};
	}

	const usable = config.provider !== "" && config.model !== "";
	if (!usable) {
		issues.push(
			"auto-mode: 'provider' and 'model' are required; auto mode will defer every request until they are set",
		);
	}

	return { config, issues, usable };
}
