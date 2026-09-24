import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalPath } from "./capture.js";
import { QualityController, type QualityUI } from "./controller.js";
import { saveConfig } from "./config.js";
import { revision } from "./case.js";
import type { ReviewResult } from "./reviewer.js";
import { QUALITY_CHECK_ENTRY } from "./feedback.js";
import {
	createQualityActivityPublisher,
	QUALITY_ACTIVITY_CHANNEL,
	type QualityActivityEvent,
} from "./activity.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function harness() {
	const activityEvents: QualityActivityEvent[] = [];
	const captureActivityEvent = (channel: string, event: unknown) => {
		if (channel === QUALITY_ACTIVITY_CHANNEL) activityEvents.push(event as QualityActivityEvent);
	};
	const activity = createQualityActivityPublisher({
		on: () => () => {},
		emit: captureActivityEvent,
	});
	const dir = canonicalPath(mkdtempSync(join(tmpdir(), "quality-runtime-")));
	dirs.push(dir);
	const cwd = join(dir, "repo");
	mkdirSync(cwd);
	const agentDir = join(dir, "agent");
	saveConfig(agentDir, { provider: "test", model: "reviewer" });
	const entries: unknown[] = [];
	const pi = {
		appendEntry: vi.fn((customType: string, data: unknown) =>
			entries.push({ type: "custom", customType, data }),
		),
		sendMessage: vi.fn(),
	};
	const ctx = {
		cwd,
		mode: "tui",
		signal: undefined,
		sessionManager: { getSessionId: () => "session", getBranch: () => entries },
		ui: { setStatus: vi.fn(), notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true) },
		abort: vi.fn(),
		modelRegistry: {},
	} as unknown as ExtensionContext;
	const ui: QualityUI = {
		arbitrate: vi.fn().mockResolvedValue(undefined),
		coverage: vi.fn().mockResolvedValue(undefined),
		failure: vi.fn().mockResolvedValue(undefined),
	};
	const review = vi.fn().mockResolvedValue(approved());
	const runtime = new QualityController(pi, agentDir, { ui, review, activity });
	runtime.start(ctx);
	return {
		dir,
		cwd,
		agentDir,
		entries,
		pi,
		ctx,
		ui,
		review,
		runtime,
		activityEvents,
		path: join(cwd, "a.ts"),
	};
}
function approved(): ReviewResult {
	return {
		kind: "verdict",
		value: { verdict: "approved", rationale: "Clear", findings: [], edits: [], proposed: {} },
		metrics: { requests: 1, latencyMs: 1, usages: [] },
	};
}
async function edit(h: ReturnType<typeof harness>, text: string) {
	expect(await h.runtime.beforeTool("write", { path: h.path, content: text }, h.ctx)).toBeUndefined();
	writeFileSync(h.path, text);
	return h.runtime.boundary(h.ctx, "completed");
}
it("logs checking once per review and attaches compact approval metadata", async () => {
	const h = harness();
	h.review.mockImplementation(async (options) => {
		expect(h.pi.appendEntry).toHaveBeenCalledWith(QUALITY_CHECK_ENTRY, { caseId: h.runtime.state!.id });
		options.onAttempt?.(1);
		options.onAttempt?.(2);
		return approved();
	});
	const result = await edit(h, "const count = 1;");
	expect(h.pi.appendEntry.mock.calls.filter(([type]) => type === QUALITY_CHECK_ENTRY)).toHaveLength(1);
	expect(result?.entries).toEqual([
		{
			type: "custom_message",
			customType: "code-quality:feedback",
			content: expect.stringContaining("Quality approved"),
			display: true,
			details: { outcome: "approved" },
		},
	]);
	expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("code-quality", "approved");
});

it("numbers rejection log lines from one", async () => {
	const h = harness();
	h.review.mockResolvedValue(namingRejection(h.path, "x"));
	const initial = await edit(h, "x");
	expect(initial?.entries?.[0]).toMatchObject({
		details: { outcome: "rejected", rejection: 1 },
		content: expect.stringContaining("Name the count"),
	});
	expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("code-quality", "handling rejection 1");
	await disagree(h, "This is a coordinate name.");
	const second = await h.runtime.boundary(h.ctx, "completed");
	expect(second?.entries?.[0]).toMatchObject({
		details: { outcome: "rejected", rejection: 2 },
		content: expect.stringContaining(h.runtime.state!.id),
	});
	expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("code-quality", "handling rejection 2");
});

it("does not label an explicitly waived failed review as approved", async () => {
	const h = harness();
	h.review.mockResolvedValue({
		kind: "failed",
		reason: "offline",
		metrics: { requests: 5, latencyMs: 0, usages: [] },
	});
	vi.mocked(h.ui.failure).mockResolvedValue("waive");
	const result = await edit(h, "const count = 1;");
	expect(result?.entries?.[0]).toMatchObject({ details: { outcome: "waived" } });
	expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("code-quality", "waived");
});

it("reviews distant changes in one file together without adding conversation context", async () => {
	const h = harness();
	const unchangedLines = Array.from({ length: 80 }, (_, index) => `const padding${index} = ${index};`).join(
		"\n",
	);
	writeFileSync(h.path, `import { format } from "./format.js";\n${unchangedLines}\nformat(invoice);\n`);
	await edit(h, `import { formatInvoice } from "./format.js";\n${unchangedLines}\nformatInvoice(invoice);\n`);
	expect(h.review).toHaveBeenCalledTimes(1);
	const request = h.review.mock.calls[0]![0].request;
	expect(request.files).toHaveLength(1);
	expect(request.files[0].visibleRanges).toHaveLength(2);
	expect(request.input).toContain("import { formatInvoice }");
	expect(request.input).toContain("formatInvoice(invoice);");
	expect(request.notes).toEqual([]);
	expect(Object.keys(request).sort()).toEqual(["files", "input", "notes"]);
	expect(h.runtime.state?.resolution).toBe("model_approved");
});

it("publishes one batch verdict to all corresponding edit/write IDs", async () => {
	const h = harness();
	const secondPath = join(h.cwd, "b.ts");
	expect(await h.runtime.beforeTool("write", { path: h.path }, h.ctx, "write-a")).toBeUndefined();
	expect(await h.runtime.beforeTool("write", { path: secondPath }, h.ctx, "write-b")).toBeUndefined();
	writeFileSync(h.path, "const count = 1;");
	writeFileSync(secondPath, "const total = 2;");
	h.runtime.finishTool("write-a", false);
	h.runtime.finishTool("write-b", false);
	await h.runtime.boundary(h.ctx, "completed");
	const approvals = h.activityEvents.filter((event) => event.phase === "approved");
	expect(approvals).toEqual([
		{
			version: 1,
			toolCallId: "write-a",
			sessionId: "session",
			phase: "approved",
			revision: expect.any(Number),
		},
		{
			version: 1,
			toolCallId: "write-b",
			sessionId: "session",
			phase: "approved",
			revision: expect.any(Number),
		},
	]);
});

it("shows quality exclusions and blocked calls without claiming they were reviewed", async () => {
	const h = harness();
	await h.runtime.beforeTool("write", { path: join(h.cwd, "bun.lock") }, h.ctx, "lock");
	h.runtime.finishTool("lock", false);
	expect(h.activityEvents.at(-1)).toMatchObject({ toolCallId: "lock", phase: "excluded" });
	await h.runtime.beforeTool("write", { path: "" }, h.ctx, "invalid");
	h.runtime.finishTool("invalid", true);
	expect(h.activityEvents.at(-1)).toMatchObject({ toolCallId: "invalid", phase: "blocked" });
});

it("old preparation cannot publish activity into a replacement session", async () => {
	const h = harness();
	let release!: (choice: "authorize") => void;
	vi.mocked(h.ui.coverage).mockReturnValue(
		new Promise((resolve) => {
			release = resolve;
		}),
	);
	const pending = h.runtime.beforeTool("write", { path: join(h.cwd, ".env") }, h.ctx, "old-call");
	await vi.waitFor(() => expect(h.ui.coverage).toHaveBeenCalled());
	h.runtime.start(h.ctx);
	const eventsBeforeStaleCompletion = h.activityEvents.length;
	release("authorize");
	await pending;
	expect(h.activityEvents).toHaveLength(eventsBeforeStaleCompletion);
});

it("coalesces writes and waits for review before producing the boundary result", async () => {
	const h = harness();
	let release!: (value: ReviewResult) => void;
	h.review.mockReturnValue(
		new Promise((resolve) => {
			release = resolve;
		}),
	);
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "const value = 1;\n");
	const pending = h.runtime.boundary(h.ctx, "completed");
	await vi.waitFor(() => expect(h.runtime.state?.phase).toBe("reviewing"));
	release(approved());
	await pending;
	expect(h.runtime.state?.resolution).toBe("model_approved");
	expect(h.review).toHaveBeenCalledTimes(1);
});
it("auto-approves exclusions without snapshots, model calls, or reviewer configuration", async () => {
	const h = harness();
	h.runtime.config = { ...h.runtime.config, provider: undefined, model: undefined };
	const path = join(h.cwd, "bun.lock");
	expect(await h.runtime.beforeTool("write", { path }, h.ctx)).toBeUndefined();
	writeFileSync(path, "x".repeat(300000));
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.review).not.toHaveBeenCalled();
	expect(h.runtime.state).toBeUndefined();
	expect(h.pi.appendEntry).toHaveBeenCalledWith(
		"code-quality:excluded",
		expect.objectContaining({ status: "auto_approved", reviewed: false }),
	);
});
it("arbitrates only after five disagreements and verifies exact user-approved application", async () => {
	const h = harness();
	h.review.mockResolvedValue({
		...approved(),
		value: {
			verdict: "needs_work",
			rationale: "Name the value",
			findings: [
				{ file: h.path, line: 1, quote: "const x", rule: "names", rationale: "Use a meaningful name" },
			],
			edits: [{ file: h.path, oldText: "const x = 1;", newText: "const count = 1;" }],
			proposed: { [h.path]: "const count = 1;" },
		},
	});
	await edit(h, "const x = 1;");
	expect(h.runtime.state?.phase).toBe("correcting");
	expect(await h.runtime.beforeTool("write", { path: join(h.cwd, "unrelated.ts") }, h.ctx)).toMatchObject({
		block: true,
	});
	vi.mocked(h.ui.arbitrate).mockResolvedValue({ choice: "proposed", note: "Use count" });
	for (let round = 1; round <= 5; round++) {
		await h.runtime.respond(
			{
				action: "disagree",
				caseId: h.runtime.state!.id,
				revision: revision(h.runtime.state!),
				rationale: "Short name is sufficient",
			},
			h.ctx,
		);
		expect(h.ui.arbitrate).not.toHaveBeenCalled();
		await h.runtime.boundary(h.ctx, "completed");
		expect(h.runtime.state?.attempts).toBe(round);
	}
	expect(h.ui.arbitrate).toHaveBeenCalledTimes(1);
	expect(h.runtime.state?.phase).toBe("applying");
	await edit(h, "const count = 1;");
	expect(h.runtime.state?.resolution).toBe("user_approved");
	expect(h.review).toHaveBeenCalledTimes(6);
	expect(h.review.mock.calls[1]![0].request.objection).toBe("Short name is sufficient");
	expect(readFileSync(h.path, "utf8")).toBe("const count = 1;");
});
function namingRejection(path: string, currentText: string): ReviewResult {
	return {
		kind: "verdict",
		value: {
			verdict: "needs_work",
			rationale: "Name the count",
			findings: [{ file: path, line: 1, quote: currentText, rule: "names", rationale: "Name the count" }],
			edits: [{ file: path, oldText: currentText, newText: "const count = 1;" }],
			proposed: { [path]: "const count = 1;" },
		},
		metrics: { requests: 1, latencyMs: 1, usages: [] },
	};
}

async function disagree(h: ReturnType<typeof harness>, rationale: string): Promise<void> {
	await h.runtime.respond(
		{
			action: "disagree",
			caseId: h.runtime.state!.id,
			revision: revision(h.runtime.state!),
			rationale,
		},
		h.ctx,
	);
}

it("lets the reviewer approve a disagreement without contacting the operator", async () => {
	const h = harness();
	h.review.mockResolvedValueOnce(namingRejection(h.path, "x"));
	await edit(h, "x");
	await disagree(h, "The name is the coordinate used in the surrounding formula.");
	expect(h.runtime.state?.phase).toBe("captured");
	expect(h.runtime.state?.attempts).toBe(0);
	const result = await h.runtime.boundary(h.ctx, "completed");
	expect(result?.continue).toBe(false);
	expect(h.runtime.state).toMatchObject({ phase: "closed", resolution: "model_approved", attempts: 1 });
	expect(h.review.mock.calls[1]![0].request.objection).toBe(
		"The name is the coordinate used in the surrounding formula.",
	);
	expect(h.review.mock.calls[1]![0].request.notes).toEqual([]);
	expect(h.ui.arbitrate).not.toHaveBeenCalled();
	expect(h.ui.failure).not.toHaveBeenCalled();
	expect(h.ui.coverage).not.toHaveBeenCalled();
	expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
	expect(readFileSync(h.path, "utf8")).toBe("x");
});

it("counts edits and disagreements together, and permits approval on round five", async () => {
	const h = harness();
	h.review.mockImplementation(async (options) => namingRejection(h.path, options.request.files[0].after));
	await edit(h, "x0");
	await disagree(h, "This name is sufficient in the test fixture.");
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state?.attempts).toBe(1);
	await edit(h, "x1");
	expect(h.runtime.state?.attempts).toBe(2);
	expect(h.review.mock.calls.at(-1)![0].request.objection).toBeUndefined();
	await disagree(h, "The revised name follows the neighboring examples.");
	await h.runtime.boundary(h.ctx, "completed");
	await edit(h, "x2");
	expect(h.runtime.state?.attempts).toBe(4);
	h.review.mockResolvedValueOnce(approved());
	await disagree(h, "This is a coordinate, not a count.");
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state).toMatchObject({ attempts: 5, phase: "closed", resolution: "model_approved" });
	expect(h.ui.arbitrate).not.toHaveBeenCalled();
});

it("restores pending reconsideration after a provider failure without spending another round", async () => {
	const h = harness();
	h.review.mockResolvedValueOnce(namingRejection(h.path, "x"));
	await edit(h, "x");
	await disagree(h, "This is the coordinate's domain name.");
	h.review.mockResolvedValueOnce({
		kind: "failed",
		reason: "offline",
		metrics: { requests: 5, latencyMs: 20, usages: [] },
	});
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state).toMatchObject({ attempts: 0, reconsiderationPending: true, phase: "paused" });
	h.runtime.start(h.ctx);
	expect(h.runtime.state?.objection).toBe("This is the coordinate's domain name.");
	await h.runtime.command("retry", h.ctx);
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state).toMatchObject({
		attempts: 1,
		reconsiderationPending: false,
		resolution: "model_approved",
	});
	expect(h.review.mock.calls.at(-1)![0].request.objection).toBe("This is the coordinate's domain name.");
	expect(h.ui.arbitrate).not.toHaveBeenCalled();
});

it("counts a reconsideration across file groups only after every group returns a verdict", async () => {
	const h = harness();
	const secondPath = join(h.cwd, "b.ts");
	h.review.mockImplementation(async (options) =>
		namingRejection(options.request.files[0].path, options.request.files[0].after),
	);
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	await h.runtime.beforeTool("write", { path: secondPath }, h.ctx);
	writeFileSync(h.path, "x");
	writeFileSync(secondPath, "y");
	await h.runtime.boundary(h.ctx, "completed");
	await disagree(h, "These are the coordinate names.");
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.review).toHaveBeenCalledTimes(4);
	expect(h.runtime.state?.attempts).toBe(1);
	expect(h.review.mock.calls[2]![0].request.objection).toBe("These are the coordinate names.");
	expect(h.review.mock.calls[3]![0].request.objection).toBe("These are the coordinate names.");
	expect(h.ui.arbitrate).not.toHaveBeenCalled();
});

it("sends an unresolved finish back for review rather than escalating early", async () => {
	const h = harness();
	h.review.mockResolvedValue(namingRejection(h.path, "x"));
	await edit(h, "x");
	const result = await h.runtime.boundary(h.ctx, "completed", true);
	expect(result?.continue).toBe(true);
	expect(h.runtime.state).toMatchObject({ attempts: 1, phase: "correcting" });
	expect(h.ui.arbitrate).not.toHaveBeenCalled();
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.review).toHaveBeenCalledTimes(2);
});

it("rejects duplicate, oversized, and stale disagreements without consuming rounds", async () => {
	const h = harness();
	h.review.mockResolvedValue(namingRejection(h.path, "x"));
	await edit(h, "x");
	await expect(disagree(h, " ")).rejects.toThrow("1–2000");
	await expect(disagree(h, "x".repeat(2001))).rejects.toThrow("1–2000");
	await disagree(h, "This name is intentional.");
	await expect(disagree(h, "Second response to the same pending review.")).rejects.toThrow(
		"Wait for the current review",
	);
	writeFileSync(h.path, "externally changed");
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.review.mock.calls.at(-1)![0].request.objection).toBeUndefined();
	expect(h.runtime.state?.attempts).toBe(0);
	expect(h.ui.arbitrate).not.toHaveBeenCalled();
});

it("keeps reconsideration pending when interrupted and resumes it after reload", async () => {
	const h = harness();
	h.review.mockResolvedValueOnce(namingRejection(h.path, "x"));
	await edit(h, "x");
	await disagree(h, "The surrounding calculation explains this coordinate name.");
	await h.runtime.boundary(h.ctx, "aborted");
	expect(h.runtime.state).toMatchObject({ phase: "paused", attempts: 0, reconsiderationPending: true });
	expect(h.review).toHaveBeenCalledTimes(1);
	h.runtime.start(h.ctx);
	await h.runtime.command("retry", h.ctx);
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state).toMatchObject({ attempts: 1, phase: "closed", resolution: "model_approved" });
	expect(h.ui.arbitrate).not.toHaveBeenCalled();
});

it("allows another five disagreement rounds only after the operator extends the limit", async () => {
	const h = harness();
	h.review.mockResolvedValue(namingRejection(h.path, "x"));
	vi.mocked(h.ui.arbitrate).mockResolvedValue({
		choice: "continue",
		note: "Keep discussing the coordinate name.",
	});
	await edit(h, "x");
	for (let round = 1; round <= 10; round++) {
		await disagree(h, "The coordinate name is intentional.");
		await h.runtime.boundary(h.ctx, "completed");
		expect(h.runtime.state?.attempts).toBe(round);
		expect(h.ui.arbitrate).toHaveBeenCalledTimes(Math.floor(round / 5));
	}
	expect(h.runtime.state?.limit).toBe(15);
	expect(h.review.mock.calls.at(-1)![0].request.notes).toContain("Keep discussing the coordinate name.");
});

it("restores a pending case across reload and reconciles abort-after-write", async () => {
	const h = harness();
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "pending");
	await h.runtime.boundary(h.ctx, "aborted");
	expect(h.runtime.state?.phase).toBe("paused");
	const restored = new QualityController(h.pi, h.agentDir, { ui: h.ui, review: h.review });
	restored.start(h.ctx);
	expect(restored.pending).toBe(true);
	expect(restored.state?.files[0]?.after).toBe("pending");
	expect(h.review).not.toHaveBeenCalled();
});
it("invalidates results if an external editor changed the reviewed snapshot", async () => {
	const h = harness();
	h.review.mockImplementation(async () => {
		writeFileSync(h.path, "external");
		return approved();
	});
	await edit(h, "original");
	expect(h.runtime.state?.resolution).toBeUndefined();
	expect(h.runtime.state?.phase).toBe("captured");
	expect(h.runtime.state?.files[0]?.after).toBe("external");
});
it("arbitrates after exactly five correction attempts and preserves the next allowance", async () => {
	const h = harness();
	h.review.mockImplementation(async (options) => {
		const file = options.request.files[0];
		return {
			...approved(),
			value: {
				verdict: "needs_work",
				rationale: "Still unclear",
				findings: [{ file: h.path, line: 1, quote: file.after, rule: "names", rationale: "Name intent" }],
				edits: [{ file: h.path, oldText: file.after, newText: "const count = 1;" }],
				proposed: { [h.path]: "const count = 1;" },
			},
		};
	});
	vi.mocked(h.ui.arbitrate).mockResolvedValue({ choice: "continue", note: "Try a local name" });
	await edit(h, "const x0 = 1;");
	for (let i = 1; i <= 4; i++) await edit(h, `const x${i} = 1;`);
	expect(h.ui.arbitrate).not.toHaveBeenCalled();
	await edit(h, "const x5 = 1;");
	expect(h.ui.arbitrate).toHaveBeenCalledTimes(1);
	expect(h.runtime.state).toMatchObject({
		attempts: 5,
		limit: 10,
		phase: "correcting",
		notes: ["Try a local name"],
	});
});

it("new secrets require authorization after a write and are not silently sent or persisted", async () => {
	const h = harness();
	vi.mocked(h.ui.coverage).mockResolvedValue(undefined);
	await edit(h, "Bearer " + "x".repeat(30));
	expect(h.ui.coverage).toHaveBeenCalled();
	expect(h.review).not.toHaveBeenCalled();
	expect(h.runtime.state?.phase).toBe("paused");
	expect(h.runtime.state?.files[0]?.after).toBeNull();
});

it("does not let a previous file waiver skip a later ordinary source review", async () => {
	const h = harness();
	writeFileSync(h.path, "Bearer " + "x".repeat(30));
	vi.mocked(h.ui.coverage).mockResolvedValue("waive");
	await edit(h, "const count = 1;");
	expect(h.review).not.toHaveBeenCalled();
	await edit(h, "const count = 2;");
	expect(h.review).toHaveBeenCalledTimes(1);
});

it("keeps a correction attempt pending across provider failure and retry", async () => {
	const h = harness();
	const reject = {
		...approved(),
		value: {
			verdict: "needs_work",
			rationale: "Name intent",
			findings: [{ file: h.path, line: 1, quote: "x", rule: "names", rationale: "Name intent" }],
			edits: [{ file: h.path, oldText: "x", newText: "count" }],
			proposed: { [h.path]: "count" },
		},
	};
	h.review.mockResolvedValueOnce(reject);
	await edit(h, "x");
	h.review.mockResolvedValueOnce({
		kind: "failed",
		reason: "offline",
		metrics: { requests: 5, latencyMs: 0, usages: [] },
	});
	await edit(h, "xx");
	expect(h.runtime.state?.attempts).toBe(0);
	expect(h.runtime.state?.correctionPending).toBe(true);
	await h.runtime.command("retry", h.ctx);
	h.review.mockResolvedValueOnce({
		...reject,
		value: { ...reject.value, edits: [{ file: h.path, oldText: "xx", newText: "count" }] },
	});
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state?.attempts).toBe(1);
});

it("reload preserves approved proposal application and branch changes cancel late reviews", async () => {
	const h = harness();
	h.review.mockResolvedValue({
		...approved(),
		value: {
			verdict: "needs_work",
			rationale: "Name intent",
			findings: [{ file: h.path, line: 1, quote: "x", rule: "names", rationale: "Name intent" }],
			edits: [{ file: h.path, oldText: "x", newText: "count" }],
			proposed: { [h.path]: "count" },
		},
	});
	await edit(h, "x");
	await h.runtime.command("resolve", h.ctx);
	vi.mocked(h.ui.arbitrate).mockResolvedValue({ choice: "proposed", note: "count" });
	await h.runtime.boundary(h.ctx, "completed");
	const restored = new QualityController(h.pi, h.agentDir, { ui: h.ui, review: h.review });
	restored.start(h.ctx);
	expect(restored.state?.phase).toBe("applying");
	expect(await restored.beforeTool("write", { path: h.path }, h.ctx)).toBeUndefined();
	writeFileSync(h.path, "count");
	await restored.boundary(h.ctx, "completed");
	expect(restored.state?.resolution).toBe("user_approved");

	const second = harness();
	let release!: (value: ReviewResult) => void;
	second.review.mockReturnValue(
		new Promise((resolve) => {
			release = resolve;
		}),
	);
	await second.runtime.beforeTool("write", { path: second.path }, second.ctx);
	writeFileSync(second.path, "pending");
	const pending = second.runtime.boundary(second.ctx, "completed");
	await vi.waitFor(() => expect(second.runtime.state?.phase).toBe("reviewing"));
	second.runtime.dispose();
	release(approved());
	expect(await pending).toBeUndefined();
	expect(second.runtime.state?.resolution).toBeUndefined();
});

it("failure cancellation pauses without automatic acceptance", async () => {
	const h = harness();
	h.review.mockResolvedValue({
		kind: "failed",
		reason: "Five attempts exhausted",
		metrics: { requests: 5, latencyMs: 20, usages: [] },
	});
	await edit(h, "const count = 1;");
	expect(h.runtime.state?.phase).toBe("paused");
	expect(h.runtime.state?.resolution).toBeUndefined();
	expect(h.ctx.abort).toHaveBeenCalled();
});

it("non-TUI modes do not call a reviewer or enforce mutation checks", async () => {
	const h = harness();
	h.ctx.mode = "print";
	h.runtime.start(h.ctx);
	expect(await h.runtime.beforeTool("write", { path: h.path }, h.ctx)).toBeUndefined();
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.review).not.toHaveBeenCalled();
});
