import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fingerprints, validateDraft } from "./profile.js";
import { initializeStorage, publish, storageRoot } from "./storage.js";
import { fixture, put, testDraft } from "./test-fixtures.js";
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("fingerprints many distinct sources without starting unbounded reads", async () => {
	let active = 0,
		peak = 0;
	const paths = Array.from({ length: 200 }, (_, index) => `docs/${index}.md`);
	const draft = validateDraft({
		...testDraft,
		specialists: Array.from({ length: 7 }, (_, index) => ({
			id: `lens-${index}`,
			name: `Lens ${index}`,
			focus: "Fixture",
			requiredReading: paths.slice(index * 32, (index + 1) * 32),
			always: true,
			anyOf: [],
		})),
	});
	const result = await fingerprints(draft, async (path) => {
		active++;
		peak = Math.max(peak, active);
		await new Promise<void>((resolve) => setImmediate(resolve));
		active--;
		return Buffer.from(path);
	});
	expect(peak).toBe(1);
	expect(Object.keys(result)).toHaveLength(paths.length);
});
it("refuses ignore-all rules undone by negations in another Git checkout", async () => {
	const storeRepo = await fixture(),
		reviewedRepo = await fixture();
	roots.push(storeRepo.root, reviewedRepo.root);
	const root = await storageRoot(join(storeRepo.root, "agent"), reviewedRepo);
	await put(root, ".gitignore", "*\n!*/\n!*.json\n");
	const destination = join(root, "private-report.json");
	await expect(publish(root, destination, { private: "fixture" }, undefined)).rejects.toThrow(
		"conflicting rules",
	);
	await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("*\n!*/\n!*.json\n");
});
it("accepts only ignore-all plus harmless blank lines/comments", async () => {
	const root = await mkdtemp(join(tmpdir(), "pr-ignore-"));
	roots.push(root);
	await put(root, ".gitignore", "# private runtime\n\n*\n");
	await expect(initializeStorage(root)).resolves.toBeUndefined();
	await put(root, ".gitignore", " *\n");
	await expect(initializeStorage(root)).rejects.toThrow("ignore-all");
});
