import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import {
	installedPlannotator,
	interpretDecision,
	present,
	viewerDiffType,
	type Seed,
} from "./plannotator.js";
import { capture, commit, fixture, put, testConfig } from "./test-fixtures.js";
import type { Report } from "./types.js";
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function plannotatorCommands(path: string, name = "plannotator-review"): Pick<ExtensionAPI, "getCommands"> {
	return {
		getCommands: () => [
			{
				name,
				source: "extension",
				sourceInfo: { path, source: "npm:@plannotator/pi-extension", scope: "user", origin: "package" },
			},
		],
	};
}
async function plannotatorFixture(version: unknown): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pr-plannotator-version-"));
	roots.push(root);
	await put(root, "package.json", JSON.stringify({ name: "@plannotator/pi-extension", version }));
	await put(root, "index.ts", "");
	await put(root, "server.ts", "");
	await put(root, "review-editor.html", "");
	return root;
}
it.each([
	"0.27.11",
	"0.27.12",
	"0.27.14",
	"0.27.16",
	"0.27.14-beta.1",
	"0.28.0",
	"99.0.0",
	undefined,
	null,
	27,
])("discovers loaded Plannotator without gating version metadata %s", async (version) => {
	const root = await plannotatorFixture(version);
	await expect(installedPlannotator(plannotatorCommands(root))).resolves.toBe(root);
	await expect(
		installedPlannotator(plannotatorCommands(join(root, "index.ts"), "plannotator-review:1")),
	).resolves.toBe(root);
});
it("requires a loaded Plannotator package and its viewer assets", async () => {
	await expect(installedPlannotator({ getCommands: () => [] })).rejects.toThrow("already-loaded");
	const root = await plannotatorFixture("0.27.14");
	await rm(join(root, "review-editor.html"));
	await expect(installedPlannotator(plannotatorCommands(root))).rejects.toThrow("already-loaded");
	await put(root, "review-editor.html", "");
	await put(root, "package.json", JSON.stringify({ name: "not-plannotator", version: "0.27.14" }));
	await expect(installedPlannotator(plannotatorCommands(root))).rejects.toThrow("already-loaded");
});
const seed: Seed = {
	findingIds: ["F1"],
	annotation: {
		source: "pr-review:run",
		type: "concern",
		scope: "line",
		filePath: "a.ts",
		lineStart: 1,
		lineEnd: 1,
		side: "new",
		text: "Original verified finding",
	},
};
const annotation = { ...seed.annotation, id: "u1" };
it("labels captured scopes without claiming every snapshot is uncommitted", () => {
	expect(viewerDiffType({ scope: { kind: "local" }, baseline: "head", head: "head" })).toBe("uncommitted");
	expect(viewerDiffType({ scope: { kind: "local" }, baseline: "parent", head: "head" })).toBe("last-commit");
	expect(
		viewerDiffType({
			scope: { kind: "commits", count: 2, committedOnly: true },
			baseline: "base",
			head: "head",
		}),
	).toBe("branch");
	expect(
		viewerDiffType({
			scope: { kind: "base", ref: "main", committedOnly: false },
			baseline: "base",
			head: "head",
		}),
	).toBe("since-base");
});
it("authorizes only retained unedited submitted findings, never LGTM or Close", () => {
	expect(
		interpretDecision({ approved: false, feedback: "fix", annotations: [annotation] }, [seed], ["u1"])
			.requestedIds,
	).toEqual(["F1"]);
	for (const decision of [{ approved: true }, { approved: false, exit: true }])
		expect(
			interpretDecision({ ...decision, feedback: "notes", annotations: [annotation] }, [seed], ["u1"])
				.requestedIds,
		).toEqual([]);
	expect(
		interpretDecision({ approved: false, feedback: "", annotations: [] }, [seed], ["u1"]).requestedIds,
	).toEqual([]);
});
it("routes edits and reply threads to discussion and rejects duplicate IDs", () => {
	const edited = interpretDecision(
		{ approved: false, feedback: "question", annotations: [{ ...annotation, text: "Is this necessary?" }] },
		[seed],
		["u1"],
	);
	expect(edited.requestedIds).toEqual([]);
	expect(edited.discussion).toHaveLength(1);
	const replied = interpretDecision(
		{
			approved: false,
			feedback: "question",
			annotations: [annotation, { id: "u2", text: "Explain this", inReplyTo: "u1" }],
		},
		[seed],
		["u1"],
	);
	expect(replied.requestedIds).toEqual([]);
	expect(replied.discussion).toHaveLength(1);
	expect(() =>
		interpretDecision(
			{ approved: false, feedback: "", annotations: [annotation, annotation] },
			[seed],
			["u1"],
		),
	).toThrow("Duplicate");
	const unknown = interpretDecision(
		{ approved: false, feedback: "", annotations: [{ ...annotation, id: "another-run" }] },
		[seed],
		["u1"],
	);
	expect(unknown.requestedIds).toEqual([]);
	expect(unknown.discussion).toHaveLength(1);
});
it.skipIf(!process.env.PR_REVIEW_TEST_PI_PACKAGE || !process.env.PR_REVIEW_TEST_PLANNOTATOR_PACKAGE)(
	"round-trips the production viewer host without browser/model calls",
	async () => {
		const plannotatorDir = await installedPlannotator(
			plannotatorCommands(process.env.PR_REVIEW_TEST_PLANNOTATOR_PACKAGE!),
		);
		const repo = await fixture();
		roots.push(repo.root);
		await put(repo.root, "a.ts", "export const test = false;\n");
		await commit(repo.root);
		await put(repo.root, "a.ts", "export const test = true;\n");
		const scope = { kind: "base" as const, ref: "main", committedOnly: false };
		const snapshot = await capture(repo, scope, testConfig);
		const root = await mkdtemp(join(tmpdir(), "pr-ui-test-"));
		roots.push(root);
		const report: Report = {
			version: 1,
			id: "00000000-0000-0000-0000-000000000001",
			repoId: repo.id,
			project: "Fixture",
			createdAt: new Date().toISOString(),
			scope,
			baseline: snapshot.baseline,
			head: snapshot.head,
			fingerprint: snapshot.fingerprint,
			profileHash: "fixture",
			promptHashes: {},
			model: "fake/test",
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
		};
		let submission: Promise<void> | undefined;
		let probeFailure: unknown;
		const controller = new AbortController();
		let permissionRevision = "old",
			authorizationCalls = 0;
		const result = await present({
			root,
			piPackageDir: process.env.PR_REVIEW_TEST_PI_PACKAGE!,
			plannotatorDir,
			report,
			snapshot,
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
			openBrowser: false,
			authorize: async () => {
				authorizationCalls++;
				if (authorizationCalls === 2) {
					permissionRevision = "new";
					return "old";
				}
				return permissionRevision;
			},
			permissionRevision: () => permissionRevision,
			progress(message) {
				const url = message.match(/http:\/\/\S+/)?.[0];
				if (url)
					submission = (async () => {
						const diff = await (await fetch(`${url}/api/diff`)).json();
						expect(diff.rawPatch).toBe(snapshot.changes.map((change) => change.patch).join(""));
						expect(diff.gitContext).toBeUndefined();
						const seeded = await (await fetch(`${url}/api/external-annotations`)).json();
						expect(seeded.annotations[0].text).toContain(JSON.stringify(scope));
						expect(seeded.annotations[0].text).toContain(snapshot.baseline);
						const response = await fetch(`${url}/api/feedback`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ approved: true, feedback: "Synthetic LGTM", annotations: [] }),
						});
						expect(response.ok).toBe(true);
					})().catch((error) => {
						probeFailure = error;
						controller.abort();
					});
			},
		}).catch((error) => {
			throw probeFailure ?? error;
		});
		await submission;
		expect(authorizationCalls).toBe(3);
		expect(result.decision).toBe("lgtm");
		expect(result.requestedIds).toEqual([]);
		expect(await readdir(join(root, "viewer-sessions"))).toEqual([]);
	},
	45000,
);
