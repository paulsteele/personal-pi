import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ObserverConfig {
	provider: string;
	model: string;
	enabledByDefault: boolean;
	timeoutMs: number;
	turnInterval: number;
	maxAgeMs: number;
}

export const DEFAULT_CONFIG: ObserverConfig = Object.freeze({
	provider: "litellm",
	model: "amod-gpt-5.6-luna",
	enabledByDefault: true,
	timeoutMs: 20_000,
	turnInterval: 5,
	maxAgeMs: 120_000,
});

export function configPath(agentDir: string): string {
	return join(agentDir, "extensions", "progress-observer", "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(raw: unknown): { config?: ObserverConfig; issues: string[] } {
	if (!isRecord(raw)) return { issues: ["config: expected an object"] };
	const known = new Set(["provider", "model", "enabledByDefault", "timeoutMs", "turnInterval", "maxAgeMs"]);
	const issues = Object.keys(raw)
		.filter((key) => !known.has(key))
		.map((key) => `${key}: unknown setting`);
	const stringField = (key: "provider" | "model"): string => {
		const value = raw[key];
		if (typeof value !== "string" || value.trim().length === 0) {
			issues.push(`${key}: expected a non-empty string`);
			return DEFAULT_CONFIG[key];
		}
		return value.trim();
	};
	const integerField = (key: "timeoutMs" | "turnInterval" | "maxAgeMs", min: number, max: number): number => {
		const value = raw[key];
		if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
			issues.push(`${key}: expected an integer from ${min} to ${max}`);
			return DEFAULT_CONFIG[key];
		}
		return value;
	};
	const enabled = raw.enabledByDefault;
	if (typeof enabled !== "boolean") issues.push("enabledByDefault: expected a boolean");
	const config: ObserverConfig = {
		provider: stringField("provider"),
		model: stringField("model"),
		enabledByDefault: typeof enabled === "boolean" ? enabled : DEFAULT_CONFIG.enabledByDefault,
		timeoutMs: integerField("timeoutMs", 250, 60_000),
		turnInterval: integerField("turnInterval", 1, 100),
		maxAgeMs: integerField("maxAgeMs", 10_000, 3_600_000),
	};
	return issues.length === 0 ? { config, issues } : { issues };
}

export function loadConfig(agentDir: string): { config?: ObserverConfig; issues: string[] } {
	const path = configPath(agentDir);
	try {
		return validate(JSON.parse(readFileSync(path, "utf8")) as unknown);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { config: { ...DEFAULT_CONFIG }, issues: [] };
		return { issues: [`Invalid global observer config at ${path}.`] };
	}
}

function save(agentDir: string, patch: Partial<ObserverConfig>): ObserverConfig {
	const loaded = loadConfig(agentDir);
	if (!loaded.config && existsSync(configPath(agentDir))) {
		throw new Error(`Refusing to overwrite invalid observer config: ${loaded.issues.join("; ")}`);
	}
	const next = { ...(loaded.config ?? DEFAULT_CONFIG), ...patch };
	const path = configPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	renameSync(temp, path);
	return next;
}

export function saveEnabled(agentDir: string, enabledByDefault: boolean): ObserverConfig {
	return save(agentDir, { enabledByDefault });
}

export function saveModel(agentDir: string, provider: string, model: string): ObserverConfig {
	return save(agentDir, { provider, model });
}
