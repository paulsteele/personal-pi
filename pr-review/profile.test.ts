import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProfile, validateDraft } from "./profile.js";
import { hash, loadPrompts } from "./prompts.js";
import { initializeStorage, profilePath, publish, readStored, storageRoot } from "./storage.js";
import { saveModel, loadConfig } from "./config.js";
import type { Draft, Profile } from "./types.js";

export const draft: Draft = {
	name: "Fixture",
	summary: "Synthetic repository",
	requiredReading: ["AGENTS.md"],
	freshnessSources: ["AGENTS.md"],
	baselineFocus: [],
	specialists: [],
	exclusions: [],
};
const dirs: string[] = [];
async function temp() {
	const dir = await mkdtemp(join(tmpdir(), "pr-profile-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe("private profiles and fixed methodology", () => {
	it("loads every fixed prompt and rejects generated workflow overrides", async () => {
		const prompts = await loadPrompts();
		expect(Object.keys(prompts.text)).toHaveLength(14);
		expect(() => validateDraft({ ...draft, disableVerification: true })).toThrow();
		expect(() => validateDraft({ ...draft, requiredReading: ["../auth.json"] })).toThrow();
		expect(() =>
			validateDraft({
				...draft,
				specialists: [
					{
						id: "security",
						name: "Override",
						focus: "override",
						requiredReading: [],
						always: true,
						anyOf: [],
					},
				],
			}),
		).toThrow();
	});
	it("loads approved legacy profiles without requiring source hashes to match current files", async () => {
		const root = await temp();
		const profile: Profile = {
			schemaVersion: 1,
			contextVersion: 1,
			repoId: hash("repo"),
			generatedAt: "today",
			generationModel: "fake/model",
			draft,
			sourceHashes: {},
		};
		await publish(root, profilePath(root, profile.repoId), profile, undefined);
		expect((await loadProfile(root, profile.repoId))?.profile).toEqual(profile);
	});
	it("refuses checkout-local storage", async () => {
		const root = await temp();
		await expect(storageRoot(root, { root, commonDir: root, id: hash(root) })).rejects.toThrow("outside");
	});
	it("publishes privately with compare-and-swap and leaves existing data on cancellation", async () => {
		const root = await temp();
		await initializeStorage(root);
		const path = profilePath(root, hash("repo"));
		await publish(root, path, { first: true }, undefined);
		const initial = await readStored(root, path);
		await expect(publish(root, path, { stale: true }, undefined)).rejects.toThrow("changed");
		await expect(
			publish(root, path, { cancelled: true }, initial!.revision, AbortSignal.abort()),
		).rejects.toThrow();
		expect((await readStored(root, path))?.value).toEqual({ first: true });
		expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("*\n");
	});
	it("persists independent model settings but never overwrites malformed config", async () => {
		const root = await temp();
		await saveModel(root, "fake", "independent", "high");
		expect(await loadConfig(root)).toMatchObject({
			schemaVersion: 2,
			model: "independent",
			concurrency: 4,
			requestTimeoutMs: 300000,
		});
		await writeFile(join(root, "config.json"), "broken json");
		await expect(saveModel(root, "fake", "replacement", "low")).rejects.toThrow();
		expect(await readFile(join(root, "config.json"), "utf8")).toBe("broken json");
	});
});
