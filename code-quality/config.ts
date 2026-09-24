import { readFileSync, mkdirSync, writeFileSync, renameSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalPath } from "./capture.js";

export interface QualityConfig {
	enabled: boolean;
	provider?: string;
	model?: string;
	timeoutMs: number;
	maxFileBytes: number;
	maxBatchBytes: number;
	maxInputChars: number;
	maxOutputTokens: number;
}

export const DEFAULT_CONFIG: QualityConfig = Object.freeze({
	enabled: true,
	timeoutMs: 30_000,
	maxFileBytes: 262_144,
	maxBatchBytes: 1_048_576,
	maxInputChars: 64_000,
	maxOutputTokens: 8_000,
});
export const configPath = (agentDir: string): string =>
	join(agentDir, "extensions", "code-quality", "config.json");

export function parseConfig(value: unknown): QualityConfig {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected a configuration object");
	const raw = value as Record<string, unknown>;
	const known = new Set([...Object.keys(DEFAULT_CONFIG), "provider", "model"]);
	for (const key of Object.keys(raw)) if (!known.has(key)) throw new Error(`Unknown quality setting: ${key}`);
	const config = { ...DEFAULT_CONFIG, ...raw } as QualityConfig;
	if (typeof config.enabled !== "boolean") throw new Error("enabled must be a boolean");
	const limits = {
		timeoutMs: [250, 300_000],
		maxFileBytes: [1024, 16_777_216],
		maxBatchBytes: [1024, 67_108_864],
		maxInputChars: [1024, 1_000_000],
		maxOutputTokens: [256, 32_000],
	} as const;
	for (const [key, [min, max]] of Object.entries(limits)) {
		const value = config[key as keyof typeof limits];
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
			throw new Error(`Invalid quality setting: ${key}`);
	}
	if (config.provider !== undefined || config.model !== undefined) {
		if (
			typeof config.provider !== "string" ||
			!config.provider.trim() ||
			typeof config.model !== "string" ||
			!config.model.trim()
		)
			throw new Error("Select both provider and model");
		config.provider = config.provider.trim();
		config.model = config.model.trim();
	}
	return config;
}

export function loadConfig(agentDir: string): { config: QualityConfig; error?: string } {
	try {
		return { config: parseConfig(JSON.parse(readFileSync(configPath(agentDir), "utf8"))) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: { ...DEFAULT_CONFIG } };
		return {
			config: { ...DEFAULT_CONFIG },
			error: `Invalid quality config: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function saveConfig(agentDir: string, patch: Partial<QualityConfig>): QualityConfig {
	const loaded = loadConfig(agentDir);
	if (loaded.error) throw new Error(loaded.error);
	const next = parseConfig({ ...loaded.config, ...patch });
	const path = configPath(canonicalPath(agentDir));
	for (let candidate = path; ; candidate = dirname(candidate)) {
		try {
			if (lstatSync(candidate).isSymbolicLink()) throw new Error("Refusing symlink quality configuration");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (dirname(candidate) === candidate) break;
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
	renameSync(temp, path);
	return next;
}
