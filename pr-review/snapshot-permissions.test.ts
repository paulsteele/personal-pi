import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { capture, snapshotTools } from "./snapshot.js";
import { SnapshotStore } from "./snapshot-store.js";
import { PermissionScope, openReviewPermissions, type PermissionAction } from "./permissions.js";
import { fixture, put, testConfig, testAccess } from "./test-fixtures.js";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

it("does not read blocked search files or disclose rejected matches", async () => {
	const repo = await fixture();
	roots.push(repo.root);
	await put(repo.root, "blocked.ts", "needle blocked\n");
	await put(repo.root, "rejected.ts", "needle rejected\n");
	await put(repo.root, "unmatched.ts", "ordinary source\n");
	const copying = vi.spyOn(SnapshotStore.prototype, "copy");
	const captured = await capture(repo, { kind: "local" }, testConfig, testAccess(), [], undefined, {
		mode: "discovery",
	});
	const disclose = vi.fn(async (_action: PermissionAction) => ({
		kind: "denied" as const,
		reason: "disclosure denied",
	}));
	const access = testAccess(disclose, async (action) =>
		action.effects?.[0]?.path.endsWith("/blocked.ts")
			? { kind: "denied", reason: "local scan blocked" }
			: { kind: "allowed", revision: "fixture" },
	);
	try {
		const search = snapshotTools(captured.withPermissions!(access)).find(
			(tool) => tool.name === "search_source",
		)!;
		const response = await search.execute("search", { query: "needle" }, new AbortController().signal);
		const result = JSON.parse((response.content[0] as { text: string }).text);
		expect(copying.mock.calls.map(([path]) => path)).not.toContain(join(repo.root, "blocked.ts"));
		expect(result.matches).toEqual([]);
		expect(result.denied).toEqual([
			{ file: "blocked.ts", reason: "local scan blocked" },
			{ file: "rejected.ts", reason: "disclosure denied" },
		]);
		expect(result.complete).toBe(false);
		expect(disclose.mock.calls.map(([action]) => action.effects?.[0]?.path)).toEqual([
			join(repo.root, "rejected.ts"),
		]);
		expect(access.dependencies).toEqual([]);
	} finally {
		await captured.dispose?.();
	}
});

it("does not eagerly copy excluded files and refuses deferred source that has drifted", async () => {
	const repo = await fixture();
	roots.push(repo.root);
	await put(repo.root, "excluded.ts", "first\n");
	await put(repo.root, "public.ts", "public\n");
	const copying = vi.spyOn(SnapshotStore.prototype, "copy");
	const snapshot = await capture(repo, { kind: "local" }, testConfig, testAccess(), [
		{ glob: "excluded.ts", reason: "fixture" },
	]);
	try {
		expect(copying.mock.calls.map(([path]) => path)).not.toContain(join(repo.root, "excluded.ts"));
		await put(repo.root, "excluded.ts", "second\n");
		await expect(snapshot.read("excluded.ts")).rejects.toThrow("Source changed");
	} finally {
		await snapshot.dispose?.();
	}
});

it("never stamps a stale allow onto a result after a live policy change during a read", async () => {
	let denied = false;
	const scope = new PermissionScope({
		revision: () => (denied ? "deny" : "allow"),
		nextTurn() {},
		endTurn() {},
		close() {},
		check: async () =>
			denied ? { kind: "denied", reason: "now denied" } : { kind: "allowed", revision: "allow" },
	});
	await expect(
		scope.guard({ toolName: "read", input: {} }, async () => {
			denied = true;
			return "private bytes";
		}),
	).rejects.toThrow("now denied");
});

it("requires one compatible loaded service before source work", () => {
	const ctx = { sessionManager: { getSessionId: () => "s" } };
	const repo = { root: "/repo", commonDir: "/repo/.git", id: "r" };
	expect(() =>
		openReviewPermissions(
			{ events: { emit() {} } } as never,
			ctx as never,
			repo,
			"local",
			new AbortController().signal,
		),
	).toThrow("requires the loaded compatible");
});
