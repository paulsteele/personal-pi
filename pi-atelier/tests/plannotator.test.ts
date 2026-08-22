import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	applyDoneMarkers,
	parseChecklist,
	plannotatorPanel,
	reconstructPlannotator,
	validateReadablePlanPath,
} from "../src/plannotator.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
	const root = join(tmpdir(), `atelier-plannotator-${crypto.randomUUID()}`);
	roots.push(root);
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "PLAN.md"), "- [ ] Inspect\n- [x] Preserve\n- [ ] Implement\n", "utf8");
	return root;
}

function state(phase: "planning" | "executing", path: string | null = "PLAN.md") {
	return { type: "custom", customType: "plannotator", data: { phase, lastSubmittedPath: path } };
}

describe("Plannotator integration", () => {
	it("renders planning before and during plan review", async () => {
		const cwd = await fixture();
		expect(reconstructPlannotator(cwd, [state("planning", null)])).toEqual({ phase: "planning" });
		const snapshot = reconstructPlannotator(cwd, [state("planning")]);
		expect(snapshot).toEqual({ phase: "planning", planPath: "PLAN.md" });
		expect(plannotatorPanel(snapshot!)).toMatchObject({
			id: "plannotator:progress",
			title: "Plannotator",
			rows: [
				{ text: "⏸ Planning", role: "warning" },
				{ text: "PLAN.md", role: "muted" },
			],
		});
	});

	it("uses a validated transient submit path until durable state catches up", async () => {
		const cwd = await fixture();
		expect(validateReadablePlanPath(cwd, "PLAN.md")).toBe("PLAN.md");
		expect(reconstructPlannotator(cwd, [state("planning", null)], "PLAN.md")).toEqual({
			phase: "planning",
			planPath: "PLAN.md",
		});
		expect(validateReadablePlanPath(cwd, "../PLAN.md")).toBeUndefined();
		expect(validateReadablePlanPath(cwd, "missing.md")).toBeUndefined();
	});

	it("replays completion markers only after the latest execution boundary", async () => {
		const cwd = await fixture();
		const snapshot = reconstructPlannotator(cwd, [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "[DONE:3]" }] } },
			{ type: "custom", customType: "plannotator-execute" },
			state("executing"),
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "[DONE:1]" }] } },
		]);
		expect(snapshot).toMatchObject({ phase: "executing", completed: 2, total: 3 });
		expect(plannotatorPanel(snapshot!).rows).toEqual([
			{ text: "2/3 complete", role: "accent" },
			{ text: "✓ 1. Inspect", role: "dim" },
			{ text: "✓ 2. Preserve", role: "dim" },
			{ text: "○ 3. Implement", role: "primary" },
		]);
	});

	it("retains checklist parser and marker behavior", () => {
		const items = parseChecklist("- [ ] one\n* [x] two\n");
		applyDoneMarkers("done [DONE:1] ignored [DONE:9]", items);
		expect(items).toEqual([
			{ step: 1, text: "one", completed: true },
			{ step: 2, text: "two", completed: true },
		]);
	});
});
