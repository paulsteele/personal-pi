import { expect, it, vi } from "vitest";
import { snapshotTools, type Snapshot } from "./snapshot.js";

it("stops file reads at the search match cap and leaves unread files for the next page", async () => {
	const read = vi.fn(async (file: string) => Buffer.from(file === "a" ? "hit\n".repeat(100) : "later hit\n"));
	const snapshot = { repo: { root: "/fixture" }, paths: () => ["a", "b", "c"], read } as unknown as Snapshot;
	const tool = snapshotTools(snapshot).find((item) => item.name === "search_source")!;
	const result = await tool.execute("fixture", { query: "hit" }, new AbortController().signal);
	const page = JSON.parse((result.content[0] as { text: string }).text);
	expect(page.scanned).toBe(1);
	expect(page.nextOffset).toBe(1);
	expect(page.matches).toHaveLength(100);
	expect(read.mock.calls.map(([file]) => file)).toEqual(["a"]);
	await tool.execute("fixture-2", { query: "hit", offset: page.nextOffset }, new AbortController().signal);
	expect(read.mock.calls.map(([file]) => file)).toEqual(["a", "b", "c"]);
});
