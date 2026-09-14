import { join } from "node:path";
import { publish, readStored } from "./storage.js";
import { ConfigSchema, RuntimeConfigSchema, validate, type Config, type RuntimeConfig } from "./types.js";

export const BUDGETS = Object.freeze({
	concurrency: 4,
	timeoutMs: 300000,
	maxTurns: 24,
	maxReviewers: 24,
	maxJobs: 128,
	maxInputBytes: 120000,
	maxFileBytes: 2 * 1024 * 1024,
	maxDiffBytes: 20 * 1024 * 1024,
	historyLimit: 20,
});
export const DEFAULT_CONFIG = Object.freeze({ concurrency: 4, requestTimeoutMs: 300000, historyLimit: 20 });
export const LEGACY_NOTICE =
	"PR review no longer applies saved job/reviewer/turn/input/file/diff quotas. Coverage continues until complete or cancelled; timeout applies to individual requests only.";
/** Pure migration: reading preferences never rewrites private state. */
export function normalizeConfig(config: Config): RuntimeConfig {
	if (config.schemaVersion === 2) return config;
	return {
		schemaVersion: 2,
		provider: config.provider,
		model: config.model,
		thinking: config.thinking,
		concurrency: config.concurrency,
		requestTimeoutMs: config.timeoutMs,
		historyLimit: config.historyLimit,
	};
}
export async function loadConfig(
	root: string,
	notice?: (message: string) => void,
): Promise<RuntimeConfig | undefined> {
	const stored = await readStored(root, join(root, "config.json"));
	if (!stored) return undefined;
	const config = validate(ConfigSchema, stored.value);
	if (config.schemaVersion === 1) notice?.(LEGACY_NOTICE);
	return normalizeConfig(config);
}
export async function saveModel(
	root: string,
	provider: string,
	model: string,
	thinking: Config["thinking"],
	signal?: AbortSignal,
): Promise<Config> {
	const path = join(root, "config.json");
	const stored = await readStored(root, path);
	const current = stored
		? normalizeConfig(validate(ConfigSchema, stored.value))
		: { schemaVersion: 2 as const, ...DEFAULT_CONFIG };
	const next = validate(RuntimeConfigSchema, { ...current, provider, model, thinking });
	await publish(root, path, next, stored?.revision, signal);
	return next;
}
