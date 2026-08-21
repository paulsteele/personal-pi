import { describe, expect, test } from "bun:test";
import {
	applyDoneMarkers,
	isAtelierDiscovery,
	parseChecklist,
	reconstructProgress,
	snapshotRows,
} from "./core.ts";

const cwd = "/tmp/project";
const plan = `# Plan

- [ ] Inspect state
- [x] Keep existing behavior
* [ ] Add the sidebar
`;

function stateEntries(extra: Array<Record<string, unknown>> = []) {
	return [
		{ type: "custom", customType: "plannotator-execute", data: { lastSubmittedPath: "PLAN.md" } },
		{ type: "custom", customType: "plannotator", data: { phase: "executing", lastSubmittedPath: "PLAN.md" } },
		...extra,
	];
}

describe("checklist reconstruction", () => {
	test("parses markdown checkboxes and applies completion markers", () => {
		const items = parseChecklist(plan);
		expect(items).toEqual([
			{ step: 1, text: "Inspect state", completed: false },
			{ step: 2, text: "Keep existing behavior", completed: true },
			{ step: 3, text: "Add the sidebar", completed: false },
		]);
		applyDoneMarkers("Finished [DONE:1] and ignored [DONE:99].", items);
		expect(items.map((item) => item.completed)).toEqual([true, true, false]);
	});

	test("replays assistant markers after the latest execution boundary", () => {
		const snapshot = reconstructProgress(
			cwd,
			stateEntries([
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "Done [DONE:1]" }] },
				},
			]),
			(path) => {
				expect(path.endsWith("/tmp/project/PLAN.md")).toBe(true);
				return plan;
			},
		);
		expect(snapshot?.completed).toBe(2);
		expect(snapshot?.total).toBe(3);
		expect(snapshotRows(snapshot!)).toEqual([
			{ text: "2/3 complete", role: "accent" },
			{ text: "✓ 1. Inspect state", role: "dim" },
			{ text: "✓ 2. Keep existing behavior", role: "dim" },
			{ text: "○ 3. Add the sidebar", role: "primary" },
		]);
	});

	test("hides idle, missing, and escaping plans", () => {
		expect(
			reconstructProgress(cwd, [
				{ type: "custom", customType: "plannotator", data: { phase: "idle", lastSubmittedPath: "PLAN.md" } },
			]),
		).toBeUndefined();
		expect(
			reconstructProgress(
				cwd,
				[{ type: "custom", customType: "plannotator", data: { phase: "executing", lastSubmittedPath: "../PLAN.md" } }],
				() => plan,
			),
		).toBeUndefined();
		expect(reconstructProgress(cwd, stateEntries(), () => { throw new Error("missing"); })).toBeUndefined();
	});
});

describe("Atelier protocol guards", () => {
	test("accepts only bounded version-one discovery requests", () => {
		expect(isAtelierDiscovery({ version: 1, type: "discover", requestId: "atelier-1" })).toBe(true);
		expect(isAtelierDiscovery({ version: 2, type: "discover", requestId: "atelier-1" })).toBe(false);
		expect(isAtelierDiscovery({ version: 1, type: "discover", requestId: "bad\nrequest" })).toBe(false);
	});
});
