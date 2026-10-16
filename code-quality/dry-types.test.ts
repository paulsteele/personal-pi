import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { DEFAULT_DRY_PROFILE, parseDryProfile } from "./dry-profile.js";
import { newCase } from "./case.js";
import { CaseStore } from "./state.js";
import { validateDryVerdict, type DryEvidence, type DryVerdict } from "./dry-types.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});
const evidence: DryEvidence = {
	id: "a".repeat(64),
	changed: {
		file: "/repo/new.ts",
		range: [3, 4],
		hash: "b".repeat(64),
		text: "const expiryDays = 30;\nreturn expiryDays;",
		changedRanges: [[3, 3]],
	},
	counterpart: {
		file: "/repo/existing.ts",
		range: [8, 9],
		hash: "c".repeat(64),
		text: "const retentionDays = 30;\nreturn retentionDays;",
		changedRanges: [],
	},
	signals: ["literal:30", "identifier:days"],
	score: 2,
};
const rejection: DryVerdict = {
	verdict: "needs_work",
	rationale: "One retention policy needs a single owner",
	findings: [
		{
			pairId: evidence.id,
			file: "/repo/new.ts",
			line: 3,
			quote: "const expiryDays = 30;",
			counterpartFile: "/repo/existing.ts",
			counterpartRange: [8, 8],
			counterpartQuote: "const retentionDays = 30;",
			duplicatedKnowledge: "The retention duration",
			sharedOwnershipRationale: "Both copies express the same retention policy",
			correctionDirection: "Reference a shared retention-duration constant",
		},
	],
};
it("accepts a cited DRY rejection without a patch", () => {
	expect(validateDryVerdict(rejection, [evidence])).toEqual(rejection);
	expect(rejection).not.toHaveProperty("edits");
	expect(
		validateDryVerdict({ verdict: "approved", rationale: "Independent policies", findings: [] }, [evidence])
			.verdict,
	).toBe("approved");
});
it("rejects ungrounded changed and counterpart citations", () => {
	const finding = rejection.findings[0]!;
	expect(() => validateDryVerdict({ ...rejection, findings: [{ ...finding, line: 4 }] }, [evidence])).toThrow(
		"eligible changed line",
	);
	expect(() =>
		validateDryVerdict({ ...rejection, findings: [{ ...finding, counterpartQuote: "invented" }] }, [
			evidence,
		]),
	).toThrow("counterpart citation");
	expect(() =>
		validateDryVerdict({ ...rejection, findings: [{ ...finding, counterpartRange: [8, 20] }] }, [evidence]),
	).toThrow("counterpart citation");
	expect(() => validateDryVerdict({ ...rejection, findings: [] }, [evidence])).toThrow("requires findings");
	expect(() => validateDryVerdict({ ...rejection, edits: [] }, [evidence])).toThrow("schema");
});
it("adds DRY defaults to legacy configuration without a separate model selection", () => {
	expect(parseConfig({ provider: "fixture", model: "shared" })).toMatchObject({
		dryEnabled: true,
		dryScanTimeoutMs: 60000,
		dryMaxInputChars: 24000,
		dryMaxOutputTokens: 1024,
	});
	expect(() => parseConfig({ dryEnabled: "yes" })).toThrow("dryEnabled");
	expect(() => parseConfig({ dryScanTimeoutMs: 0 })).toThrow("dryScanTimeoutMs");
});
it("loads existing profiles without retaining their retired cache budget", () => {
	const profile = parseDryProfile({ ...DEFAULT_DRY_PROFILE, maxCacheBytes: 256 * 1024 * 1024 });
	expect(profile).toEqual(DEFAULT_DRY_PROFILE);
	expect(profile).not.toHaveProperty("maxCacheBytes");
	expect(() => parseDryProfile({ ...DEFAULT_DRY_PROFILE, unknownSetting: true })).toThrow("profile");
});
it("defaults a missing include list while keeping a saved source byte cap", () => {
	const { include: _include, ...legacyProfile } = {
		...DEFAULT_DRY_PROFILE,
		maxSourceBytes: 64 * 1024 * 1024,
	};
	const profile = parseDryProfile(legacyProfile);
	expect(profile.include).toEqual([]);
	expect(profile.maxSourceBytes).toBe(64 * 1024 * 1024);
});
it("restores both legacy cases and finding-only DRY evidence", () => {
	const directory = mkdtempSync(join(tmpdir(), "dry-case-contract-"));
	directories.push(directory);
	const store = new CaseStore(join(directory, "agent"), "/repo");
	const legacy = newCase("/repo", "fixture/shared");
	expect(store.load(store.save(legacy))).toEqual(legacy);
	const pending = {
		...legacy,
		activeRejectionSource: "dry" as const,
		dryRequiredPaths: ["/repo/new.ts"],
		dry: {
			verdict: rejection,
			evidence: [evidence],
			coverage: [],
			revision: "d".repeat(64),
			manifestRevision: "e".repeat(64),
			configuration: "f".repeat(64),
			generation: "session:1",
			providerKey: "fixture/shared",
		},
	};
	expect(store.load(store.save(pending))).toEqual(pending);
});
