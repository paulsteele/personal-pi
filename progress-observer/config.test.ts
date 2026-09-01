import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configPath, DEFAULT_CONFIG, loadConfig, saveEnabled, saveModel } from "./config.js";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "progress-observer-config-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("observer config", () => {
	it("uses independent Luna defaults when the file is absent", () => {
		const loaded = loadConfig(tempDir());
		expect(loaded).toEqual({ config: { ...DEFAULT_CONFIG }, issues: [] });
	});

	it("rejects malformed or unknown settings", () => {
		const dir = tempDir();
		const path = configPath(dir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ ...DEFAULT_CONFIG, timeoutMs: 2, surprise: true }), {
			encoding: "utf8",
			flag: "w",
		});
		const loaded = loadConfig(dir);
		expect(loaded.config).toBeUndefined();
		expect(loaded.issues.join(" ")).toContain("timeoutMs");
		expect(loaded.issues.join(" ")).toContain("surprise");
	});

	it("atomically persists toggles and model selection", () => {
		const dir = tempDir();
		expect(saveEnabled(dir, false).enabledByDefault).toBe(false);
		expect(saveModel(dir, "openai", "small")).toMatchObject({ provider: "openai", model: "small" });
		const saved = JSON.parse(readFileSync(configPath(dir), "utf8"));
		expect(saved).toMatchObject({ enabledByDefault: false, provider: "openai", model: "small" });
		expect(dirname(configPath(dir))).toContain("progress-observer");
	});
});
