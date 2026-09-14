import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createRunJournal } from "./journal.js";
import { TaskStore } from "./tasks.js";
it("persists useful live state before completion without source bodies or credentials", async () => {
	const root = await mkdtemp(join(tmpdir(), "pr-journal-")),
		store = new TaskStore(),
		onError = vi.fn();
	store.add({ id: "review", name: "Reviewer", stage: "review", files: ["a.ts"], reason: "whole change" });
	const journal = await createRunJournal(root, "a".repeat(64), store, onError);
	try {
		store.update("review", { state: "blocked" }, "Provider failed: Bearer abcdefghijklmnopqrstuvwxyz");
		await vi.waitFor(
			async () => expect(JSON.parse(await readFile(journal.path, "utf8")).tasks[0].state).toBe("blocked"),
			{ timeout: 3000 },
		);
		const text = await readFile(journal.path, "utf8");
		expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
		expect(JSON.parse(text).finished).toBe(false);
		store.cancel();
		await journal.close();
		const final = JSON.parse(await readFile(journal.path, "utf8"));
		expect(final.finished).toBe(true);
		expect(final.tasks[0].state).toBe("cancelled");
		expect(onError).not.toHaveBeenCalled();
	} finally {
		await journal.close();
		await rm(root, { recursive: true, force: true });
	}
});
