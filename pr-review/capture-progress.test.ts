import { afterEach, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { capture } from "./snapshot.js";
import { fixture, put, testAccess, testConfig } from "./test-fixtures.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("reports scanning, individual source capture, diff preparation, and validation before completion", async () => {
	const repo = await fixture();
	roots.push(repo.root);
	await put(repo.root, "a.ts", "const a = 1;\n");
	await put(repo.root, "b.ts", "const b = 2;\n");
	const progress: string[] = [];
	const snapshot = await capture(
		repo,
		{ kind: "local" },
		testConfig,
		testAccess(),
		[],
		undefined,
		{ mode: "review" },
		(message) => progress.push(message),
	);
	try {
		expect(progress).toContain("Scanning repository and Git attributes");
		expect(progress).toContain("Capturing working source 1/2: a.ts");
		expect(progress).toContain("Capturing working source 2/2: b.ts");
		expect(progress).toContain("Preparing source diff 1/2: a.ts");
		expect(progress).toContain("Preparing source diff 2/2: b.ts");
		expect(progress).toContain("Verifying repository did not change during capture");
		expect(progress.at(-1)).toBe("Source capture ready: 2 changes, 0 omitted");
		expect(snapshot.changes.map((change) => change.file)).toEqual(["a.ts", "b.ts"]);
	} finally {
		await snapshot.dispose?.();
	}
});

it("reports the pending source before waiting for its permission check and preserves cancellation", async () => {
	const repo = await fixture();
	roots.push(repo.root);
	await put(repo.root, "a.ts", "const a = 1;\n");
	const controller = new AbortController();
	const progress: string[] = [];
	const access = testAccess(async (action) => {
		if (action.input && (action.input as { path?: string }).path === join(repo.root, "a.ts")) {
			expect(progress.at(-1)).toBe("Capturing working source 1/1: a.ts");
			controller.abort();
			return { kind: "cancelled", reason: "Capture cancelled" };
		}
		return { kind: "allowed", revision: "fixture" };
	});
	await expect(
		capture(
			repo,
			{ kind: "local" },
			testConfig,
			access,
			[],
			controller.signal,
			{ mode: "review" },
			(message) => progress.push(message),
		),
	).rejects.toThrow("Permission review cancelled.");
	expect(progress.some((message) => message.startsWith("Source capture ready"))).toBe(false);
});
