import { join } from "node:path";
import { publish, readStored } from "./storage.js";
import { ConfigSchema, validate, type Config } from "./types.js";

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
export async function loadConfig(root: string): Promise<Config | undefined> {
	const stored = await readStored(root, join(root, "config.json"));
	return stored ? validate(ConfigSchema, stored.value) : undefined;
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
	const current = stored ? validate(ConfigSchema, stored.value) : { schemaVersion: 1 as const, ...BUDGETS };
	const next = validate(ConfigSchema, { ...current, provider, model, thinking });
	await publish(root, path, next, stored?.revision, signal);
	return next;
}
