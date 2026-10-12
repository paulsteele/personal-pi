import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { installedPlannotator, interpretDecision, viewerDiffType, type Seed } from "./plannotator.js";
import { put } from "./test-fixtures.js";
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
