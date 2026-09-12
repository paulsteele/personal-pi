import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "./setup.js";
import { saveModel } from "./config.js";
import { fixture, put, testDraft } from "./test-fixtures.js";
import { profilePath } from "./storage.js";
import { runWorker } from "./worker.js";
vi.mock("./worker.js", () => ({ runWorker: vi.fn() }));
const dirs: string[] = [];
afterEach(async () => {
	vi.resetAllMocks();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it("uses the same approved setup flow to create and replace generated context", async () => {
	const repo = await fixture();
	dirs.push(repo.root);
	const root = await mkdtemp(join(tmpdir(), "pr-setup-store-"));
	dirs.push(root);
	await put(repo.root, "AGENTS.md", "Repository rules\n");
	await saveModel(root, "fake", "independent", "off");
	const draft = { ...testDraft, requiredReading: ["AGENTS.md"], freshnessSources: ["AGENTS.md"] };
	const ui = {
		select: vi.fn().mockResolvedValue("Approve"),
		editor: vi.fn().mockResolvedValue(JSON.stringify(draft)),
		confirm: vi.fn().mockResolvedValue(false),
	};
	const ctx = { ui, modelRegistry: {} } as unknown as ExtensionContext;
	const generate = () => {
		vi.mocked(runWorker).mockResolvedValueOnce({
			ok: true,
			value: { notes: "fixture", sources: ["AGENTS.md"], questions: [] },
			usage: { input: 0, output: 0, cost: 0 },
		});
		vi.mocked(runWorker).mockResolvedValueOnce({
			ok: true,
			value: draft,
			usage: { input: 0, output: 0, cost: 0 },
		});
	};
	generate();
	await setup(ctx, repo, root, new AbortController().signal, () => {});
	const path = profilePath(root, repo.id);
	const original = await readFile(path, "utf8");
	expect(JSON.parse(original)).toMatchObject({ repoId: repo.id, generationModel: "fake/independent" });
	await put(repo.root, "AGENTS.md", "Updated rules\n");
	generate();
	ui.select.mockResolvedValueOnce("Cancel");
	await expect(setup(ctx, repo, root, new AbortController().signal, () => {})).rejects.toThrow("cancelled");
	expect(await readFile(path, "utf8")).toBe(original);
	generate();
	await setup(ctx, repo, root, new AbortController().signal, () => {});
	expect(JSON.parse(await readFile(path, "utf8")).sourceHashes).not.toEqual(
		JSON.parse(original).sourceHashes,
	);
});
