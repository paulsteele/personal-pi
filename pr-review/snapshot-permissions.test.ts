import { mkdtemp, readFile, readdir, rm, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { capture, contextResources, snapshotTools } from "./snapshot.js";
import { SnapshotStore } from "./snapshot-store.js";
import { PermissionScope, openReviewPermissions } from "./permissions.js";
import { commit, fixture, put, testConfig, testAccess } from "./test-fixtures.js";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const restricted = (name: string) =>
	testAccess(async (action) =>
		action.effects?.some((effect) => effect.path.endsWith(`/${name}`))
			? { kind: "denied", reason: "fixture path denied" }
			: { kind: "allowed", revision: "fixture" },
	);

it("checks paths before copying dirty source and never serializes denied changed content", async () => {
	const repo = await fixture();
	roots.push(repo.root);
	await put(repo.root, "secret.ts", "OLD_SYNTHETIC_PRIVATE_SENTINEL\n");
	await put(repo.root, "public.ts", "old public\n");
	await commit(repo.root);
	await put(repo.root, "secret.ts", "NEW_SYNTHETIC_PRIVATE_SENTINEL\n");
	await put(repo.root, "public.ts", "new public\n");
	const copying = vi.spyOn(SnapshotStore.prototype, "copy");
	const snapshot = await capture(repo, { kind: "local" }, testConfig, restricted("secret.ts"));
	try {
		expect(copying.mock.calls.map(([path]) => path)).not.toContain(join(repo.root, "secret.ts"));
		expect(snapshot.omitted).toContainEqual(expect.objectContaining({ file: "secret.ts", permission: true }));
		expect(snapshot.changes.map((change) => change.file)).toEqual(["public.ts"]);
		const directory = dirname(snapshot.changes[0]!.patchPath!);
		for (const file of await readdir(directory))
			expect(await readFile(join(directory, file), "utf8")).not.toContain("SYNTHETIC_PRIVATE_SENTINEL");
		await expect(snapshot.read("secret.ts")).rejects.toThrow("fixture path denied");
	} finally {
		await snapshot.dispose?.();
	}
});

it("gates unchanged/baseline, cached reads, direct diff tools, inline context and export", async () => {
	const repo = await fixture();
	roots.push(repo.root);
	await put(repo.root, "secret.ts", "same body\n");
	await put(repo.root, "duplicate.ts", "same body\n");
	await commit(repo.root);
	await put(repo.root, "secret.ts", "changed private body\n");
	const captured = await capture(repo, { kind: "local" }, testConfig, testAccess());
	try {
		await captured.read("duplicate.ts");
		const snapshot = captured.withPermissions!(restricted("secret.ts"));
		for (const read of [
			() => snapshot.read("secret.ts"),
			() => snapshot.read("secret.ts", "old"),
			() => snapshot.page!("secret.ts", "new", 0),
			() => snapshot.readLines!("secret.ts", "old", 1, 1, 100),
			() => snapshot.lineCount!("secret.ts", "new"),
			() => snapshot.changePage!("secret.ts", 0),
		])
			await expect(read()).rejects.toThrow("fixture path denied");
		const tool = snapshotTools(snapshot).find((tool) => tool.name === "read_change")!;
		await expect(tool.execute("diff", { path: "secret.ts" }, new AbortController().signal)).rejects.toThrow(
			"fixture path denied",
		);
		for (const id of ["diff:secret.ts", "doc:secret.ts"]) {
			const resource = contextResources(snapshot, [id], 1000, new AbortController().signal);
			await expect(resource.next()).rejects.toThrow("fixture path denied");
		}
		const output = await mkdtemp(join(tmpdir(), "pr-private-export-"));
		roots.push(output);
		await expect(snapshot.writePatch!(join(output, "diff.patch"))).rejects.toThrow("fixture path denied");
		const search = await snapshotTools(snapshot)
			.find((tool) => tool.name === "search_source")!
			.execute("search", { query: "private" }, new AbortController().signal);
		const result = JSON.parse((search.content[0] as { text: string }).text);
		expect(result.denied).toHaveLength(1);
		expect(result.complete).toBe(false);
		expect(result.matches).toEqual([]);
	} finally {
		await captured.dispose?.();
	}
});

it("checks the actual old name of a rename, not only the requested new alias", async () => {
	const repo = await fixture();
	roots.push(repo.root);
	await put(repo.root, "private.ts", "same body\n");
	await commit(repo.root);
	await rename(join(repo.root, "private.ts"), join(repo.root, "public.ts"));
	const captured = await capture(repo, { kind: "local" }, testConfig, testAccess());
	try {
		expect(captured.changes[0]?.oldPath).toBe("private.ts");
		const view = captured.withPermissions!(restricted("private.ts"));
		await expect(view.read("public.ts", "old")).rejects.toThrow("fixture path denied");
		await expect(view.changePage!("public.ts", 0)).rejects.toThrow("fixture path denied");
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
