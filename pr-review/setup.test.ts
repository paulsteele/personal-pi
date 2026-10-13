import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { approveSetup, setup as setupSource } from "./setup.js";
import { saveModel } from "./config.js";
import { fixture, put, testDraft, testPermissions } from "./test-fixtures.js";
const setup = (...args: Parameters<typeof setupSource>) => {
	args[7] ??= () => testPermissions();
	return setupSource(...args);
};
import { profilePath } from "./storage.js";
import { runWorker } from "./worker.js";
import { openConfigFile } from "@paulsteele/pi-shared-ui";
vi.mock("@paulsteele/pi-shared-ui", async (original) => ({
	...(await original<typeof import("@paulsteele/pi-shared-ui")>()),
	openConfigFile: vi.fn(async () => {}),
}));
vi.mock("./worker.js", () => ({ runWorker: vi.fn() }));
const dirs: string[] = [];
afterEach(async () => {
	vi.resetAllMocks();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function harness() {
	const repo = await fixture(),
		root = await mkdtemp(join(tmpdir(), "pr-setup-store-"));
	dirs.push(repo.root, root);
	await put(repo.root, "AGENTS.md", "Repository rules\n");
	await saveModel(root, "fake", "independent", "off");
	const draft = { ...testDraft, requiredReading: ["AGENTS.md"], freshnessSources: ["AGENTS.md"] };
	const ui = { select: vi.fn(), editor: vi.fn(), confirm: vi.fn().mockResolvedValue(false) };
	const piSessionId = "pr-session";
	const ctx = {
		ui,
		modelRegistry: {},
		sessionManager: { getSessionId: () => piSessionId },
	} as unknown as ExtensionContext;
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
	return {
		repo,
		root,
		draft,
		ui,
		ctx,
		generate,
		signal: new AbortController().signal,
		draftPath: join(root, "repos", repo.id, "profile-draft.json"),
	};
}
it("prints an editable draft path and activates only through explicit approval", async () => {
	const h = await harness();
	h.generate();
	const message = await setup(h.ctx, h.repo, h.root, h.signal, () => {});
	expect(message).toContain(h.draftPath);
	expect(message).toContain("/pr setup approve");
	expect(h.ui.editor).not.toHaveBeenCalled();
	expect(h.ui.select).not.toHaveBeenCalled();
	await expect(readFile(profilePath(h.root, h.repo.id))).rejects.toMatchObject({ code: "ENOENT" });
	await writeFile(h.draftPath, JSON.stringify({ ...h.draft, summary: "Human edited summary" }));
	await approveSetup(h.repo, h.root, h.signal);
	const profile = JSON.parse(await readFile(profilePath(h.root, h.repo.id), "utf8"));
	expect(profile.draft.summary).toBe("Human edited summary");
	expect(profile.sourceHashes).toEqual({});
	expect(runWorker).toHaveBeenCalledTimes(2);
	const ownerSessionIds = vi.mocked(runWorker).mock.calls.map(([options]) => options.piSessionId);
	expect(ownerSessionIds).toEqual(["pr-session", "pr-session"]);
});
it("does not regenerate an approved profile when files change; edit is model-free", async () => {
	const h = await harness();
	h.generate();
	await setup(h.ctx, h.repo, h.root, h.signal, () => {});
	await approveSetup(h.repo, h.root, h.signal);
	const original = await readFile(profilePath(h.root, h.repo.id), "utf8");
	await put(h.repo.root, "AGENTS.md", "Changed conventions\n");
	expect(await setup(h.ctx, h.repo, h.root, h.signal, () => {})).toContain("already configured");
	expect(runWorker).toHaveBeenCalledTimes(2);
	expect(await setup(h.ctx, h.repo, h.root, h.signal, () => {}, undefined, "edit")).toContain(h.draftPath);
	expect(runWorker).toHaveBeenCalledTimes(2);
	await writeFile(h.draftPath, "not json");
	await expect(approveSetup(h.repo, h.root, h.signal)).rejects.toThrow();
	expect(await readFile(profilePath(h.root, h.repo.id), "utf8")).toBe(original);
});
it("opens a generated profile draft in the fullscreen editor without activating it", async () => {
	const h = await harness();
	h.ctx.mode = "tui";
	h.generate();
	await setup(h.ctx, h.repo, h.root, h.signal, () => {});
	expect(openConfigFile).toHaveBeenCalledExactlyOnceWith(h.ctx, h.draftPath, h.signal);
	await expect(readFile(profilePath(h.root, h.repo.id))).rejects.toMatchObject({ code: "ENOENT" });
});
it("reopens an existing pending profile draft without generating another", async () => {
	const h = await harness();
	h.generate();
	await setup(h.ctx, h.repo, h.root, h.signal, () => {});
	h.ctx.mode = "tui";
	await setup(h.ctx, h.repo, h.root, h.signal, () => {});
	expect(openConfigFile).toHaveBeenCalledExactlyOnceWith(h.ctx, h.draftPath, h.signal);
	await expect(readFile(profilePath(h.root, h.repo.id))).rejects.toMatchObject({ code: "ENOENT" });
	expect(runWorker).toHaveBeenCalledTimes(2);
});
it("opens a copy of the approved profile for editing without replacing the active profile", async () => {
	const h = await harness();
	h.generate();
	await setup(h.ctx, h.repo, h.root, h.signal, () => {});
	await approveSetup(h.repo, h.root, h.signal);
	const active = await readFile(profilePath(h.root, h.repo.id), "utf8");
	h.ctx.mode = "tui";
	await setup(h.ctx, h.repo, h.root, h.signal, () => {}, undefined, "edit");
	expect(openConfigFile).toHaveBeenCalledExactlyOnceWith(h.ctx, h.draftPath, h.signal);
	expect(await readFile(profilePath(h.root, h.repo.id), "utf8")).toBe(active);
	expect(runWorker).toHaveBeenCalledTimes(2);
});
it("activates an editor-saved profile without an approval command", async () => {
	const h = await harness();
	h.ctx.mode = "tui";
	h.generate();
	vi.mocked(openConfigFile).mockImplementationOnce(async (_ctx, path) => {
		await writeFile(path, JSON.stringify({ ...h.draft, summary: "Operator-edited profile" }));
	});
	await setup(
		h.ctx,
		h.repo,
		h.root,
		h.signal,
		() => {},
		undefined,
		"normal",
		undefined,
		undefined,
		"editor-save",
	);
	expect(openConfigFile).toHaveBeenCalledExactlyOnceWith(h.ctx, h.draftPath, h.signal);
	expect(JSON.parse(await readFile(profilePath(h.root, h.repo.id), "utf8")).draft.summary).toBe(
		"Operator-edited profile",
	);
	expect(runWorker).toHaveBeenCalledTimes(2);
});
it("preserves the active profile during explicit regeneration and reuses pending drafts", async () => {
	const h = await harness();
	h.generate();
	await setup(h.ctx, h.repo, h.root, h.signal, () => {});
	await approveSetup(h.repo, h.root, h.signal);
	const original = await readFile(profilePath(h.root, h.repo.id), "utf8");
	h.generate();
	await setup(h.ctx, h.repo, h.root, h.signal, () => {}, undefined, "regenerate");
	expect(await readFile(profilePath(h.root, h.repo.id), "utf8")).toBe(original);
	expect(await setup(h.ctx, h.repo, h.root, h.signal, () => {})).toContain(h.draftPath);
	expect(runWorker).toHaveBeenCalledTimes(4);
});
