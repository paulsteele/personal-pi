import { expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { review } from "./runner.js";
import { runWorker } from "./worker.js";
import { loadPrompts } from "./prompts.js";
import { PermissionScope, ReviewPermissions } from "./permissions.js";
import type { Snapshot } from "./snapshot.js";
import { ReviewSubmission, VerificationSubmission, type Finding, type Profile } from "./types.js";
import { testConfig, testDraft } from "./test-fixtures.js";

vi.mock("./worker.js", () => ({ runWorker: vi.fn() }));

it("verifies an accepted submission after its worker container cleanup rejects", async () => {
	const finding: Finding = {
		title: "Changed default",
		severity: "high",
		file: "a.ts",
		side: "new",
		startLine: 1,
		endLine: 1,
		problem: "Fixture problem",
		suggestion: "Fixture repair",
		rationale: "Fixture rationale",
		evidence: [{ file: "a.ts", side: "new", line: 1, quote: "export const enabled = true;" }],
	};
	const permissions = new ReviewPermissions("fixture", {
		task: (spec) => ({
			check: async () => ({ kind: "allowed" as const, revision: "fixture" }),
			revision: () => "fixture",
			nextTurn() {},
			endTurn() {},
			close: async () => {
				if (spec.kind === "worker") {
					throw new Error("Reviewer removal failed");
				}
			},
		}),
		close() {},
	});
	const snapshot: Snapshot = {
		repo: { root: "/fixture", commonDir: "/fixture/.git", id: "a".repeat(64) },
		head: "head",
		baseline: "base",
		fingerprint: "snapshot",
		omitted: [],
		changes: [
			{
				file: "a.ts",
				oldPath: "a.ts",
				patch: "-export const enabled = false;\n+export const enabled = true;",
				added: ["export const enabled = true;"],
				removed: ["export const enabled = false;"],
				oldLines: new Set([1]),
				newLines: new Set([1]),
				metadataOnly: false,
			},
		],
		paths: () => ["a.ts"],
		read: async (_path, side) =>
			Buffer.from(side === "old" ? "export const enabled = false;" : "export const enabled = true;"),
		withPermissions(access: PermissionScope) {
			return { ...this, permissions: access };
		},
	};
	const profile: Profile = {
		schemaVersion: 1,
		contextVersion: 1,
		repoId: snapshot.repo.id,
		generatedAt: "fixture",
		generationModel: "fake",
		sourceHashes: {},
		draft: testDraft,
	};
	vi.mocked(runWorker).mockImplementation(async (options) => {
		const lens = (options.input as { lens?: { id: string } }).lens;
		let value: unknown = { specialists: [] };
		if (options.schema === ReviewSubmission) {
			value = { complete: true, limitations: [], findings: lens?.id === "security" ? [finding] : [] };
		}
		if (options.schema === VerificationSubmission) {
			value = { verdicts: [{ id: "F1", verdict: "confirmed", reason: "Independent evidence checked" }] };
		}
		return { ok: true, value, usage: { input: 1, output: 1, cost: 0 } } as never;
	});
	const report = await review({
		ctx: { modelRegistry: {}, sessionManager: { getSessionId: () => "session" } } as ExtensionContext,
		permissions,
		snapshot,
		profile,
		config: testConfig,
		prompts: await loadPrompts(),
		scope: { kind: "local" },
		signal: new AbortController().signal,
		progress() {},
	});
	expect(report.status).toBe("incomplete");
	expect(report.findings).toEqual([expect.objectContaining({ id: "F1", title: "Changed default" })]);
	expect(report.ledger).toEqual([expect.objectContaining({ id: "F1", verdict: "confirmed" })]);
	expect(report.issues.join("\n")).toContain("Reviewer removal failed");
	expect(vi.mocked(runWorker).mock.calls.some(([options]) => options.schema === VerificationSubmission)).toBe(
		true,
	);
});
