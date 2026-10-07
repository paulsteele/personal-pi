import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir, writeFile, rename, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as storage from "./storage.js";
import { SnapshotStore } from "./snapshot-store.js";
import { actionPayload, fitsResult } from "./handoff.js";
import { saveReport } from "./report.js";
import { prepareReport, resultPage, ResultStore } from "./result-store.js";
import type { Report } from "./types.js";

const directories: string[] = [];
const stores: ResultStore[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) {
		store.clear();
	}
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function savedFixture() {
	const root = await mkdtemp(join(tmpdir(), "pr-result-"));
	directories.push(root);
	const repo = { root: "/fixture", commonDir: "/fixture/.git", id: "a".repeat(64) };
	const report: Report = {
		version: 1,
		id: randomUUID(),
		repoId: repo.id,
		project: "Fixture",
		createdAt: "now",
		scope: { kind: "local" },
		baseline: null,
		head: null,
		fingerprint: "captured-source",
		profileHash: "profile",
		promptHashes: {},
		model: "fake",
		status: "complete",
		lenses: [],
		declined: [],
		clean: [],
		issues: [],
		omitted: [],
		changedFiles: 1,
		findings: [],
		groups: [],
		ledger: [],
		elapsedMs: 0,
		usage: { input: 0, output: 0, cost: 0 },
		browser: {
			decision: "lgtm",
			requestedIds: [],
			discussion: [],
			feedback: "Please explain. " + "😀".repeat(20000),
		},
	};
	await saveReport(root, report, 20);
	const path = join(root, "repos", repo.id, "reports", `${report.id}.json`);
	const dependencies = [{ path: "/fixture/a.ts", side: "new" as const, version: "captured-source" }];
	const entry = await prepareReport(root, path, repo, report, dependencies);
	const store = new ResultStore();
	stores.push(store);
	store.publish(entry, "session");
	return { root, repo, report, path, dependencies, entry, store };
}

it("reassembles exact action JSON from bounded Unicode-safe pages", async () => {
	const h = await savedFixture();
	const expectedText = JSON.stringify(actionPayload(h.report));
	const reads = vi.spyOn(storage, "readStored");
	const writes = vi.spyOn(SnapshotStore.prototype, "put");
	let cursor: number | null = 0;
	const fragments: string[] = [];
	while (cursor !== null) {
		const page = await h.store.page(h.entry, "session", "action", cursor);
		expect(page.offset).toBe(cursor);
		expect(page.totalCharacters).toBe(expectedText.length);
		expect(page.cursorUnits).toBe("UTF-16 code units");
		expect(fitsResult(JSON.stringify(page))).toBe(true);
		expect(await h.store.page(h.entry, "session", "action", cursor)).toEqual(page);
		fragments.push(page.text);
		if (page.nextOffset !== null) {
			expect(page.nextOffset).toBeGreaterThan(cursor);
		}
		cursor = page.nextOffset;
	}
	expect(fragments.join("")).toBe(expectedText);
	expect(reads).toHaveBeenCalledOnce();
	expect(writes).toHaveBeenCalledTimes(2);
});

it("pages worst-case JSON escaping without exceeding the encoded result budget", () => {
	const text = "\u0000".repeat(20000);
	const page = resultPage("fixture", "action", text);
	expect(page.text.length).toBe(8000);
	expect(page.nextOffset).toBe(8000);
	expect(fitsResult(JSON.stringify(page))).toBe(true);
});

it("preserves surrogate pairs at page boundaries and rejects cursors inside them", () => {
	const text = "a".repeat(7999) + "😀" + "tail";
	const first = resultPage("fixture", "action", text);
	expect(first.text).toBe("a".repeat(7999));
	expect(first.nextOffset).toBe(7999);
	const last = resultPage("fixture", "action", text, first.nextOffset!);
	expect(last.text).toBe("😀tail");
	expect(last.nextOffset).toBeNull();
	expect(() => resultPage("fixture", "action", text, 8000)).toThrow("Invalid result cursor");
});

it.each([-1, 0.5, 100, NaN, Infinity])("rejects invalid cursor %s", (cursor) => {
	expect(() => resultPage("fixture", "action", "short", cursor)).toThrow("Invalid result cursor");
});

it("permits an empty terminal page at the exact end", () => {
	expect(resultPage("fixture", "action", "short", 5)).toMatchObject({
		offset: 5,
		text: "",
		nextOffset: null,
	});
});

it("returns complete audit data without redundant generated Markdown", async () => {
	const h = await savedFixture();
	const fragments: string[] = [];
	let cursor: number | null = 0;
	while (cursor !== null) {
		const page = await h.store.page(h.entry, "session", "report", cursor);
		fragments.push(page.text);
		cursor = page.nextOffset;
	}
	const audit = JSON.parse(fragments.join(""));
	expect(audit).toEqual(h.report);
	expect(audit).not.toHaveProperty("markdown");
});

it("captures source dependency metadata without sharing caller mutations", async () => {
	const h = await savedFixture();
	h.dependencies[0]!.path = "/fixture/changed.ts";
	expect(h.entry.dependencies).toEqual([{ path: "/fixture/a.ts", side: "new", version: "captured-source" }]);
});

it("does not expose unknown reports or registrations from another session", async () => {
	const h = await savedFixture();
	expect(() => h.store.get("../profile.json", "session")).toThrow("Unknown or expired");
	expect(() => h.store.get(h.report.id, "replacement")).toThrow("Unknown or expired");
	h.store.clear();
	expect(() => h.store.get(h.report.id, "session")).toThrow("Unknown or expired");
	await expect(h.store.page(h.entry, "session", "action")).rejects.toThrow("Unknown or expired");
});

it("clears old session registrations when a new session publishes a report", async () => {
	const oldSession = await savedFixture();
	const replacement = await savedFixture();
	oldSession.store.publish(replacement.entry, "replacement");
	expect(() => oldSession.store.get(oldSession.report.id, "replacement")).toThrow("Unknown or expired");
	expect(oldSession.store.get(replacement.report.id, "replacement")).toBe(replacement.entry);
});

it("rejects a changed saved report rather than serving new authorization", async () => {
	const h = await savedFixture();
	await saveReport(h.root, { ...h.report, status: "incomplete" }, 20);
	await expect(h.store.page(h.entry, "session", "action")).rejects.toThrow("Saved review report changed");
});

it("reports a missing retained-history file without falling back", async () => {
	const h = await savedFixture();
	await rm(h.path);
	await expect(h.store.page(h.entry, "session", "report")).rejects.toThrow(
		"retained history may have removed it",
	);
});

it("rejects mismatched saved identity and final action data during preparation", async () => {
	const h = await savedFixture();
	await expect(
		prepareReport(h.root, h.path, { ...h.repo, id: "b".repeat(64) }, h.report, []),
	).rejects.toThrow("identity does not match");
	await expect(
		prepareReport(h.root, h.path, h.repo, { ...h.report, status: "incomplete" }, []),
	).rejects.toThrow("differs from the final review result");
});

it("detects in-place changes to a report after its section backing was prepared", async () => {
	const h = await savedFixture();
	await h.store.page(h.entry, "session", "action");
	const changed = { ...h.report, fingerprint: "modified-source" };
	await writeFile(h.path, JSON.stringify(changed));
	await expect(h.store.page(h.entry, "session", "action", 8000)).rejects.toThrow(
		"Saved review report changed",
	);
});

it("rejects an identical-content replacement rather than adopting a new file identity", async () => {
	const h = await savedFixture();
	await h.store.page(h.entry, "session", "action");
	const replacement = join(h.root, "replacement.json");
	await writeFile(replacement, await readFile(h.path));
	await rename(replacement, h.path);
	await expect(h.store.page(h.entry, "session", "action", 8000)).rejects.toThrow(
		"Saved review report changed",
	);
});

it("removes owned section files and sparse indexes when the session expires", async () => {
	const h = await savedFixture();
	await h.store.page(h.entry, "session", "action");
	const parent = join(h.root, "snapshots");
	const [directory] = await readdir(parent);
	expect(directory).toMatch(/^capture-/);
	h.store.clear();
	await vi.waitFor(async () => expect(await readdir(parent)).toEqual([]));
});

it("uses private file permissions for prepared section backing", async () => {
	const h = await savedFixture();
	await h.store.page(h.entry, "session", "action");
	const parent = join(h.root, "snapshots");
	const [name] = await readdir(parent);
	const directory = join(parent, name!);
	expect((await stat(directory)).mode & 0o777).toBe(0o700);
	for (const file of await readdir(directory)) {
		expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
	}
});

it("rejects invalid and surrogate-splitting cursors through the indexed retrieval path", async () => {
	const h = await savedFixture();
	const text = JSON.stringify(actionPayload(h.report));
	const emoji = text.indexOf("😀");
	await expect(h.store.page(h.entry, "session", "action", emoji + 1)).rejects.toThrow(
		"Invalid result cursor",
	);
	await expect(h.store.page(h.entry, "session", "action", text.length + 1)).rejects.toThrow(
		"Invalid result cursor",
	);
});
