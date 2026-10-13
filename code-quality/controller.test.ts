import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildReviewChunks, canonicalPath } from "./capture.js";
import { QualityController, type QualityUI } from "./controller.js";
import { DEFAULT_CONFIG, saveConfig } from "./config.js";
import { revision, resolveCase } from "./case.js";
import { CaseStore } from "./state.js";
import { digest } from "./proposal.js";
import { review as runReview, type ReviewResult } from "./reviewer.js";
import { QUALITY_CHECK_ENTRY, QUALITY_CHECK_UPDATE_ENTRY, type QualityCheckData } from "./feedback.js";
import type { LspCheckResult } from "./lsp-diagnostics.js";
import {
	createQualityActivityPublisher,
	QUALITY_ACTIVITY_CHANNEL,
	QUALITY_ATTENTION_CHANNEL,
	QUALITY_STATUS_CHANNEL,
	type QualityHeaderEvent,
	type QualityAttentionEvent,
	type QualityActivityEvent,
} from "./activity.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function harness(piSessionId = "session") {
	const activityEvents: QualityActivityEvent[] = [];
	const attentionEvents: QualityAttentionEvent[] = [];
	const qualityHeaders: QualityHeaderEvent[] = [];
	const captureActivityEvent = (channel: string, event: unknown) => {
		if (channel === QUALITY_ACTIVITY_CHANNEL) activityEvents.push(event as QualityActivityEvent);
		if (channel === QUALITY_ATTENTION_CHANNEL) attentionEvents.push(event as QualityAttentionEvent);
		if (channel === QUALITY_STATUS_CHANNEL) qualityHeaders.push(event as QualityHeaderEvent);
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
		sessionManager: { getSessionId: () => piSessionId, getBranch: () => entries },
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
		attentionEvents,
		qualityHeaders,
		path: join(cwd, "a.ts"),
	};
}
it("disabling settings requires confirming the waiver for a pending case", async () => {
	const h = harness();
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "pending");
	await h.runtime.boundary(h.ctx, "aborted");
	vi.mocked(h.ctx.ui.confirm).mockResolvedValue(false);
	await expect(h.runtime.applySettings(h.ctx, { ...h.runtime.config, enabled: false })).rejects.toThrow(
		"waiver cancelled",
	);
	expect(h.runtime.active).toBe(true);
	expect(h.runtime.pending).toBe(true);
	vi.mocked(h.ctx.ui.confirm).mockResolvedValue(true);
	await h.runtime.applySettings(h.ctx, { ...h.runtime.config, enabled: false });
	expect(h.runtime.active).toBe(false);
	expect(h.runtime.state?.resolution).toBe("waived");
});

it("does not waive or save settings after the owning interaction is cancelled", async () => {
	const h = harness();
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "pending");
	await h.runtime.boundary(h.ctx, "aborted");
	let resolveConfirmation!: (value: boolean) => void;
	vi.mocked(h.ctx.ui.confirm).mockImplementation(
		() =>
			new Promise<boolean>((resolve) => {
				resolveConfirmation = resolve;
			}),
	);
	const controller = new AbortController();
	const applying = h.runtime.applySettings(h.ctx, { ...h.runtime.config, enabled: false }, controller.signal);
	const rejected = expect(applying).rejects.toThrow();
	await vi.waitFor(() => expect(resolveConfirmation).toBeDefined());
	controller.abort();
	resolveConfirmation(true);
	await rejected;
	expect(h.runtime.active).toBe(true);
	expect(h.runtime.pending).toBe(true);
});

it("rejects a snapshot returned after branch restoration without mutating the replacement case", async () => {
	const h = harness();
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "pending");
	h.review.mockResolvedValue({
		kind: "verdict",
		value: {
			verdict: "needs_work",
			rationale: "Clarify pending source",
			findings: [],
			edits: [],
			proposed: {},
		},
		metrics: { input: 0, output: 0, cost: 0 },
	});
	await h.runtime.boundary(h.ctx, "completed");
	let resolveSnapshot!: (value: string | null) => void;
	h.runtime.ports.filesystem = {
		canonical: async (path) => path,
		snapshot: () =>
			new Promise<string | null>((resolve) => {
				resolveSnapshot = resolve;
			}),
	};
	const checking = h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	await vi.waitFor(() => expect(resolveSnapshot).toBeDefined());
	const replacement = {
		...h.ctx,
		sessionManager: { getSessionId: () => "replacement", getBranch: () => [] },
	} as unknown as ExtensionContext;
	await h.runtime.start(replacement);
	resolveSnapshot("late snapshot");
	await expect(checking).resolves.toMatchObject({ block: true });
	expect(h.runtime.state).toBeUndefined();
	expect(h.ctx.abort).not.toHaveBeenCalled();
});

it("discards a retired prepare read failure before opening replacement-session coverage UI", async () => {
	const h = harness();
	let rejectSnapshot!: (error: Error) => void;
	h.runtime.ports.filesystem = {
		canonical: async (path) => path,
		snapshot: () =>
			new Promise((_resolve, reject) => {
				rejectSnapshot = reject;
			}),
	};
	const pending = h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	await vi.waitFor(() => expect(rejectSnapshot).toBeDefined());
	const restoredContext = {
		...h.ctx,
		sessionManager: { getSessionId: () => "session", getBranch: () => [] },
	} as unknown as ExtensionContext;
	await h.runtime.start(restoredContext);
	rejectSnapshot(new Error("Guest filesystem stopped during branch replacement"));
	await pending;
	expect(h.ui.coverage).not.toHaveBeenCalled();
	expect(h.ctx.abort).not.toHaveBeenCalled();
	expect(h.runtime.state).toBeUndefined();
	expect(h.runtime.pending).toBe(false);
});

it("discards a retired reconcile read failure before opening replacement-session coverage UI", async () => {
	const h = harness();
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "pending");
	let rejectSnapshot!: (error: Error) => void;
	h.runtime.ports.filesystem = {
		canonical: async (path) => path,
		snapshot: () =>
			new Promise((_resolve, reject) => {
				rejectSnapshot = reject;
			}),
	};
	const pending = h.runtime.boundary(h.ctx, "completed");
	await vi.waitFor(() => expect(rejectSnapshot).toBeDefined());
	const restoredContext = {
		...h.ctx,
		sessionManager: { getSessionId: () => "session", getBranch: () => [] },
	} as unknown as ExtensionContext;
	await h.runtime.start(restoredContext);
	rejectSnapshot(new Error("Guest filesystem stopped during branch replacement"));
	await pending;
	expect(h.ui.coverage).not.toHaveBeenCalled();
	expect(h.ctx.abort).not.toHaveBeenCalled();
	expect(h.runtime.state).toBeUndefined();
	expect(h.runtime.pending).toBe(false);
});

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
it.each([1, 2, 3, 4, undefined])(
	"routes LSP severity %s through the shared case before model review",
	async (severity) => {
		const h = harness();
		const check = vi.fn(
			async (): Promise<LspCheckResult> => ({
				kind: "checked",
				findings: [
					{
						file: h.path,
						serverId: "fixture",
						severity: severity as 1 | 2 | 3 | 4 | undefined,
						message: "Resolve this diagnostic",
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
					},
				],
				generation: "server",
				workspaceRevision: 0,
				hashes: {},
				elapsedMs: 1,
			}),
		);
		h.runtime.ports.lsp = { check, revision: 0, configRevision: "profile" };
		const rejected = await edit(h, "const count = 1;");
		expect(rejected?.entries?.[0]).toMatchObject({
			details: { outcome: "rejected", rejectionText: expect.stringContaining("Resolve this diagnostic") },
		});
		expect(h.ctx.ui.setStatus).toHaveBeenCalledWith("code-quality", "quality check: lsp ✕");
		expect(h.review).not.toHaveBeenCalled();
		expect(h.runtime.state).toMatchObject({
			phase: "correcting",
			attempts: 0,
			lsp: { findings: [{ message: "Resolve this diagnostic" }] },
		});
		const caseId = h.runtime.state!.id;
		check.mockResolvedValue({
			kind: "checked",
			findings: [],
			generation: "server",
			workspaceRevision: 0,
			hashes: {},
			elapsedMs: 1,
		});
		await edit(h, "const count = 2;");
		expect(h.review).toHaveBeenCalledTimes(1);
		expect(h.runtime.state).toMatchObject({ id: caseId, phase: "closed", attempts: 1 });
	},
);

it("preserves correction rounds when LSP is unavailable and the operator waives only LSP", async () => {
	const h = harness();
	h.ctx.ui.select = vi.fn().mockResolvedValue("Waive LSP for this case");
	h.runtime.ports.lsp = {
		revision: 0,
		configRevision: "profile",
		check: vi.fn(async () => ({ kind: "unavailable" as const, reason: "Server crashed" })),
	};
	await edit(h, "const count = 1;");
	expect(h.runtime.state).toMatchObject({ phase: "closed", attempts: 0, lspWaived: true });
	expect(h.review).toHaveBeenCalledTimes(1);
});

it("requires an explicit LSP waiver after coverage disappears from a pending case", async () => {
	const h = harness();
	const check = vi.fn(
		async (): Promise<LspCheckResult | undefined> => ({ kind: "stale", reason: "Concurrent edit" }),
	);
	h.runtime.ports.lsp = { revision: 0, configRevision: "profile", check };
	await edit(h, "const count = 1;");
	expect(h.runtime.state?.lspRequired).toBe(true);
	check.mockResolvedValue(undefined);
	h.ctx.ui.select = vi.fn().mockResolvedValue("Waive LSP for this case");
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
	expect(h.runtime.state).toMatchObject({ phase: "closed", lspWaived: true, attempts: 0 });
});

it("restores LSP findings and their correction counter from the active branch", async () => {
	const h = harness();
	const informationFinding = {
		file: h.path,
		serverId: "fixture",
		severity: 3 as const,
		message: "Information remains",
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
	};
	const checkedResult = {
		kind: "checked" as const,
		findings: [informationFinding],
		generation: "server",
		workspaceRevision: 0,
		hashes: {},
		elapsedMs: 1,
	};
	h.runtime.ports.lsp = { revision: 0, configRevision: "profile", check: vi.fn(async () => checkedResult) };
	await edit(h, "const count = 1;");
	await edit(h, "const count = 2;");
	const caseId = h.runtime.state!.id;
	h.runtime.start(h.ctx);
	expect(h.runtime.state).toMatchObject({
		id: caseId,
		attempts: 1,
		lspRequired: true,
		lsp: { findings: [{ severity: 3 }] },
	});
	expect(h.qualityHeaders.at(-1)?.rejectionCount).toBe(2);
});

it("keeps LSP findings after applying an exact operator-approved readability proposal", async () => {
	const h = harness();
	await edit(h, "const count = 1;");
	const state = h.runtime.state!;
	state.phase = "applying";
	state.attempts = state.limit;
	state.resolution = undefined;
	state.approvedTargets = { [h.path]: digest("const count = 1;") };
	h.runtime.ports.lsp = {
		revision: 0,
		configRevision: "profile",
		check: vi.fn(async () => ({
			kind: "checked" as const,
			findings: [
				{
					file: h.path,
					serverId: "fixture",
					severity: 2 as const,
					message: "Warning from approved patch",
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				},
			],
			generation: "server",
			workspaceRevision: 0,
			hashes: {},
			elapsedMs: 1,
		})),
	};
	vi.mocked(h.ui.arbitrate).mockResolvedValue({ choice: "continue", note: "Fix this warning" });
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.ui.arbitrate).toHaveBeenCalledTimes(1);
	expect(state).toMatchObject({
		phase: "correcting",
		attempts: 5,
		limit: 10,
		lsp: { findings: [{ severity: 2 }] },
	});
	expect(state.approvedTargets).toBeUndefined();
});

it("arbitrates LSP findings without a proposal after five unsuccessful responses", async () => {
	const h = harness();
	h.runtime.ports.lsp = {
		revision: 0,
		configRevision: "profile",
		check: vi.fn(async () => ({
			kind: "checked" as const,
			findings: [
				{
					file: h.path,
					serverId: "fixture",
					severity: 4 as const,
					message: "Hint remains",
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				},
			],
			generation: "server",
			workspaceRevision: 0,
			hashes: {},
			elapsedMs: 1,
		})),
	};
	vi.mocked(h.ui.arbitrate).mockResolvedValue({ choice: "original", note: "Accept this hint" });
	await edit(h, "const count = 1;");
	for (let response = 0; response < 5; response++) {
		expect(h.ui.arbitrate).not.toHaveBeenCalled();
		await h.runtime.respond(
			{
				action: "disagree",
				caseId: h.runtime.state!.id,
				revision: revision(h.runtime.state!),
				rationale: "Intentional",
			},
			h.ctx,
		);
		await h.runtime.boundary(h.ctx, "completed");
	}
	expect(h.ui.arbitrate).toHaveBeenCalledTimes(1);
	expect(h.runtime.state).toMatchObject({ phase: "closed", resolution: "user_approved", attempts: 5 });
	expect(h.review).not.toHaveBeenCalled();
});

it("uses the Pi owner rather than quality case IDs across edits and restored runtimes", async () => {
	const h = harness("saved-owner");
	await edit(h, "const count = 1;");
	await edit(h, "const count = 2;");
	h.runtime.start(h.ctx);
	await edit(h, "const count = 3;");
	const fork = harness("fork-owner");
	await edit(fork, "const count = 4;");
	expect(h.review.mock.calls.map(([options]) => options.piSessionId)).toEqual([
		"saved-owner",
		"saved-owner",
		"saved-owner",
	]);
	expect(fork.review.mock.calls[0]![0].piSessionId).toBe("fork-owner");
});

it("logs one readability stage across provider retries and marks its approval", async () => {
	const h = harness();
	h.review.mockImplementation(async (options) => {
		expect(h.pi.appendEntry).toHaveBeenCalledWith(QUALITY_CHECK_ENTRY, {
			checkId: expect.any(String),
			caseId: h.runtime.state!.id,
			stages: [{ source: "readability" }],
		});
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("code-quality", "quality check: readability");
		expect(h.qualityHeaders.at(-1)?.checkCount).toBe(1);
		options.onAttempt?.(1);
		options.onAttempt?.(2);
		expect(h.qualityHeaders.at(-1)?.checkCount).toBe(1);
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
	expect(h.ctx.ui.setStatus).toHaveBeenCalledWith("code-quality", "quality check: readability ✓");
	expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("code-quality", "approved");
	expect(h.pi.appendEntry).toHaveBeenCalledWith(QUALITY_CHECK_UPDATE_ENTRY, {
		checkId: expect.any(String),
		caseId: h.runtime.state!.id,
		stages: [{ source: "readability", outcome: "passed" }],
	});
	expect(h.qualityHeaders.at(-1)?.rejectionCount).toBe(0);
});

it("shows LSP progress before diagnostics and adds readability to the same pass", async () => {
	const h = harness();
	h.runtime.ports.lsp = {
		revision: 0,
		configRevision: "profile",
		check: vi.fn(async (_files, _signal, onStart): Promise<LspCheckResult> => {
			onStart?.();
			expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("code-quality", "quality check: lsp");
			expect(h.pi.appendEntry).toHaveBeenCalledWith(QUALITY_CHECK_ENTRY, {
				checkId: expect.any(String),
				caseId: h.runtime.state!.id,
				stages: [{ source: "lsp" }],
			});
			expect(h.qualityHeaders.at(-1)).toMatchObject({ phase: "checking", checkCount: 1 });
			return {
				kind: "checked",
				findings: [],
				generation: "server",
				workspaceRevision: 0,
				hashes: {},
				elapsedMs: 1,
			};
		}),
	};
	h.review.mockImplementation(async () => {
		expect(h.pi.appendEntry).toHaveBeenLastCalledWith(QUALITY_CHECK_UPDATE_ENTRY, {
			checkId: expect.any(String),
			caseId: h.runtime.state!.id,
			stages: [{ source: "lsp", outcome: "passed" }, { source: "readability" }],
		});
		return approved();
	});
	await edit(h, "const count = 1;");
	const starts = h.pi.appendEntry.mock.calls.filter(([type]) => type === QUALITY_CHECK_ENTRY);
	expect(starts).toHaveLength(1);
	const { checkId } = starts[0]![1] as QualityCheckData;
	expect(h.runtime.checkDisplay(checkId)?.stages).toEqual([
		{ source: "lsp", outcome: "passed" },
		{ source: "readability", outcome: "passed" },
	]);
	h.runtime.start(h.ctx);
	expect(h.runtime.checkDisplay(checkId)?.stages).toEqual([
		{ source: "lsp", outcome: "passed" },
		{ source: "readability", outcome: "passed" },
	]);
	expect(h.qualityHeaders.at(-1)?.checkCount).toBe(1);
	h.entries.length = 0;
	h.runtime.start(h.ctx);
	expect(h.runtime.checkDisplay(checkId)).toBeUndefined();
});

it("does not show an LSP stage when no configured route matches", async () => {
	const h = harness();
	h.runtime.ports.lsp = {
		revision: 0,
		configRevision: "profile",
		check: vi.fn().mockResolvedValue(undefined),
	};
	await edit(h, "const count = 1;");
	const starts = h.pi.appendEntry.mock.calls.filter(([type]) => type === QUALITY_CHECK_ENTRY);
	expect(starts).toHaveLength(1);
	expect(starts[0]![1]).toMatchObject({ stages: [{ source: "readability" }] });
	expect(h.ctx.ui.setStatus).not.toHaveBeenCalledWith("code-quality", "quality check: lsp");
});

it("restores an unfinished stage as interrupted rather than still running", () => {
	const h = harness();
	h.entries.push({
		type: "custom",
		customType: QUALITY_CHECK_ENTRY,
		data: { checkId: "unfinished", caseId: "old-case", stages: [{ source: "readability" }] },
	});
	h.runtime.start(h.ctx);
	expect(h.runtime.checkDisplay("unfinished")?.stages).toEqual([
		{ source: "readability", outcome: "interrupted" },
	]);
});

it("marks a stale review without approving its outdated snapshot", async () => {
	const h = harness();
	h.review.mockImplementation(async () => {
		writeFileSync(h.path, "const count = 2;");
		return approved();
	});
	const result = await edit(h, "const count = 1;");
	expect(result?.entries?.[0]).toMatchObject({ details: { outcome: "stale" } });
	expect(h.pi.appendEntry).toHaveBeenCalledWith(QUALITY_CHECK_UPDATE_ENTRY, {
		checkId: expect.any(String),
		caseId: h.runtime.state!.id,
		stages: [{ source: "readability", outcome: "stale" }],
	});
});

it("marks readability stale when guest dependency refresh changes the workspace revision", async () => {
	const h = harness();
	let workspaceRevision = 0;
	const refreshWorkspace = vi.fn(async () => {
		workspaceRevision++;
	});
	h.runtime.ports.lsp = {
		get revision() {
			return workspaceRevision;
		},
		configRevision: "profile",
		refreshWorkspace,
		check: vi.fn(async () => ({
			kind: "checked" as const,
			findings: [],
			generation: "server",
			workspaceRevision: 0,
			hashes: {},
			elapsedMs: 1,
		})),
	};
	const result = await edit(h, "const count = 1;");
	expect(refreshWorkspace).toHaveBeenCalledOnce();
	expect(result?.entries?.[0]).toMatchObject({ details: { outcome: "stale" } });
	expect(h.runtime.state?.phase).toBe("captured");
	expect(h.runtime.state?.lsp).toBeUndefined();
});

it("marks cancelled readability checks as interrupted", async () => {
	const h = harness();
	h.review.mockResolvedValue({
		kind: "cancelled",
		reason: "Cancelled",
		metrics: { requests: 1, latencyMs: 1, usages: [] },
	});
	await edit(h, "const count = 1;");
	expect(h.pi.appendEntry).toHaveBeenCalledWith(QUALITY_CHECK_UPDATE_ENTRY, {
		checkId: expect.any(String),
		caseId: h.runtime.state!.id,
		stages: [{ source: "readability", outcome: "interrupted" }],
	});
});

it("restores quality check totals from the active branch without carrying abandoned reviews", async () => {
	const h = harness();
	expect(h.qualityHeaders.at(-1)?.checkCount).toBe(0);
	await edit(h, "const count = 1;");
	expect(h.qualityHeaders.at(-1)?.checkCount).toBe(1);
	const firstReviewBranch = [...h.entries];
	await edit(h, "const count = 2;");
	expect(h.qualityHeaders.at(-1)?.checkCount).toBe(2);
	h.runtime.start(h.ctx);
	expect(h.qualityHeaders.at(-1)?.checkCount).toBe(2);
	h.entries.splice(0, h.entries.length, ...firstReviewBranch);
	h.runtime.start(h.ctx);
	expect(h.qualityHeaders.at(-1)?.checkCount).toBe(1);
	h.entries.length = 0;
	h.runtime.start(h.ctx);
	expect(h.qualityHeaders.at(-1)?.checkCount).toBe(0);
});

it("restores rejection totals across review rounds, closed cases, and branch navigation", async () => {
	const h = harness();
	expect(h.qualityHeaders.at(-1)?.rejectionCount).toBe(0);
	h.review.mockResolvedValueOnce(namingRejection(h.path, "x"));
	await edit(h, "x");
	expect(h.qualityHeaders.at(-1)).toMatchObject({ checkCount: 1, rejectionCount: 1 });
	h.runtime.start(h.ctx);
	expect(h.qualityHeaders.at(-1)?.rejectionCount).toBe(1);
	await disagree(h, "This is a coordinate name.");
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.qualityHeaders.at(-1)).toMatchObject({ checkCount: 2, rejectionCount: 1 });
	const approvedBranch = [...h.entries];
	h.review.mockResolvedValueOnce(namingRejection(h.path, "y"));
	await edit(h, "y");
	expect(h.qualityHeaders.at(-1)).toMatchObject({ checkCount: 3, rejectionCount: 2 });
	h.runtime.start(h.ctx);
	expect(h.qualityHeaders.at(-1)?.rejectionCount).toBe(2);
	h.entries.splice(0, h.entries.length, ...approvedBranch);
	h.runtime.start(h.ctx);
	expect(h.qualityHeaders.at(-1)).toMatchObject({ checkCount: 2, rejectionCount: 1 });
	h.entries.length = 0;
	h.runtime.start(h.ctx);
	expect(h.qualityHeaders.at(-1)).toMatchObject({ checkCount: 0, rejectionCount: 0 });
});

it("numbers rejection log lines from one", async () => {
	const h = harness();
	h.review.mockResolvedValue(namingRejection(h.path, "x"));
	const initial = await edit(h, "x");
	expect(initial?.entries?.[0]).toMatchObject({
		details: {
			outcome: "rejected",
			rejection: 1,
			rejectionText: `Name the count\n\n${h.path}:1 [names] Name the count`,
		},
		content: expect.stringContaining("Name the count"),
	});
	expect(h.ctx.ui.setStatus).toHaveBeenCalledWith("code-quality", "quality check: readability ✕");
	expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("code-quality", "handling rejection 1");
	await disagree(h, "This is a coordinate name.");
	const second = await h.runtime.boundary(h.ctx, "completed");
	expect(second?.entries?.[0]).toMatchObject({
		details: { outcome: "rejected", rejection: 2 },
		content: expect.stringContaining(h.runtime.state!.id),
	});
	expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("code-quality", "handling rejection 2");
	expect(h.qualityHeaders.at(-1)).toMatchObject({ checkCount: 2, rejectionCount: 2 });
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
	expect(h.ctx.ui.setStatus).toHaveBeenCalledWith("code-quality", "quality check: readability ✕");
	expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("code-quality", "waived");
	expect(h.qualityHeaders.at(-1)).toMatchObject({ checkCount: 1, rejectionCount: 0 });
	h.runtime.start(h.ctx);
	expect(h.qualityHeaders.at(-1)?.rejectionCount).toBe(0);
});

it("brackets a pending failure decision with attention events", async () => {
	const h = harness();
	h.review.mockResolvedValue({
		kind: "failed",
		reason: "offline",
		metrics: { requests: 5, latencyMs: 0, usages: [] },
	});
	let resolveFailureDecision!: (choice: "waive" | undefined) => void;
	vi.mocked(h.ui.failure).mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveFailureDecision = resolve;
			}),
	);
	const pending = edit(h, "const count = 1;");
	await vi.waitFor(() => expect(h.ui.failure).toHaveBeenCalledOnce());
	expect(h.attentionEvents).toMatchObject([{ sessionId: "session", kind: "failure", active: true }]);
	resolveFailureDecision(undefined);
	await pending;
	expect(h.attentionEvents[1]).toEqual({ ...h.attentionEvents[0], active: false });
});

it("clears attention when a coverage dialog fails", async () => {
	const h = harness();
	writeFileSync(h.path, "Bearer " + "x".repeat(30));
	vi.mocked(h.ui.coverage).mockRejectedValue(new Error("dialog closed"));
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	expect(h.attentionEvents).toMatchObject([
		{ kind: "coverage", active: true },
		{ kind: "coverage", active: false },
	]);
	expect(h.attentionEvents[1]!.requestId).toBe(h.attentionEvents[0]!.requestId);
});

it.each(["readability", "LSP"])(
	"allows additional helper and test files during %s correction without approval",
	async (rejectionSource) => {
		const h = harness();
		if (rejectionSource === "readability") {
			h.review.mockResolvedValueOnce(namingRejection(h.path, "const x = 1;"));
		} else {
			const cleanDiagnostics: LspCheckResult = {
				kind: "checked",
				findings: [],
				generation: "server",
				workspaceRevision: 0,
				hashes: {},
				elapsedMs: 1,
			};
			h.runtime.ports.lsp = {
				revision: 0,
				configRevision: "profile",
				check: vi
					.fn()
					.mockResolvedValueOnce({
						...cleanDiagnostics,
						findings: [
							{
								file: h.path,
								serverId: "fixture",
								severity: 2,
								message: "Resolve this diagnostic",
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
							},
						],
					})
					.mockResolvedValue(cleanDiagnostics),
			};
		}
		await edit(h, "const x = 1;");
		const caseId = h.runtime.state!.id;
		expect(h.runtime.state?.phase).toBe("correcting");
		h.runtime.start(h.ctx);
		const correctionFiles = [
			{ path: h.path, content: "const count = 1;" },
			{ path: join(h.cwd, "count.ts"), content: "export const initialCount = 1;" },
			{
				path: join(h.cwd, "count.test.ts"),
				content:
					"import { initialCount } from './count.js';\nif (initialCount !== 1) { throw new Error('Expected one'); }",
			},
		];
		for (const file of correctionFiles) {
			expect(await h.runtime.beforeTool("write", file, h.ctx)).toBeUndefined();
			writeFileSync(file.path, file.content);
		}
		await h.runtime.boundary(h.ctx, "completed");
		expect(h.runtime.state).toMatchObject({ id: caseId, phase: "closed", attempts: 1 });
		const correctionReviews = h.review.mock.calls.slice(rejectionSource === "readability" ? 1 : 0);
		expect(
			correctionReviews.flatMap(([review]) =>
				review.request.files.map((file: { path: string }) => file.path),
			),
		).toEqual(correctionFiles.map((file) => file.path));
		expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
		expect(h.attentionEvents).toEqual([]);
	},
);

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
	expect(h.qualityHeaders.at(-1)?.checkCount).toBe(1);
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
	expect(h.qualityHeaders.at(-1)?.checkCount).toBe(0);
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
	expect(h.attentionEvents).toEqual([]);
	vi.mocked(h.ui.arbitrate).mockImplementation(async () => {
		expect(h.attentionEvents.at(-1)).toMatchObject({ kind: "arbitration", active: true });
		return { choice: "proposed", note: "Use count" };
	});
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
	expect(h.attentionEvents).toMatchObject([
		{ kind: "arbitration", active: true },
		{ kind: "arbitration", active: false },
	]);
	expect(h.runtime.state?.phase).toBe("applying");
	expect(await h.runtime.beforeTool("write", { path: join(h.cwd, "unrelated.ts") }, h.ctx)).toEqual({
		block: true,
		reason: "Apply only the files in the user-approved proposal before continuing.",
	});
	await edit(h, "const count = 1;");
	expect(h.runtime.state?.resolution).toBe("user_approved");
	expect(h.qualityHeaders.at(-1)).toMatchObject({ checkCount: 6, rejectionCount: 6 });
	h.runtime.start(h.ctx);
	expect(h.qualityHeaders.at(-1)?.rejectionCount).toBe(6);
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

async function disagree(h: ReturnType<typeof harness>, rationale: string): Promise<string> {
	return h.runtime.respond(
		{
			action: "disagree",
			caseId: h.runtime.state!.id,
			revision: revision(h.runtime.state!),
			rationale,
		},
		h.ctx,
	);
}

it("echoes the disagreement and lets the reviewer approve it without operator arbitration", async () => {
	const h = harness();
	h.review.mockResolvedValueOnce(namingRejection(h.path, "x"));
	await edit(h, "x");
	const response = await disagree(h, "The name is the coordinate used in the surrounding formula.");
	expect(response).toBe(
		"Disagreement queued for reviewer reconsideration:\n\nThe name is the coordinate used in the surrounding formula.",
	);
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
	expect(h.qualityHeaders.at(-1)).toMatchObject({ checkCount: 2, rejectionCount: 1 });
	h.runtime.start(h.ctx);
	expect(h.qualityHeaders.at(-1)?.rejectionCount).toBe(1);
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
	expect(h.qualityHeaders.at(-1)).toMatchObject({ checkCount: 2, rejectionCount: 2 });
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

it.each([
	{ stage: "before mutation", initialContent: "x".repeat(1025) },
	{ stage: "after mutation", initialContent: null },
])("automatically waives a file over maxFileBytes $stage", async ({ initialContent }) => {
	const h = harness();
	h.runtime.config.maxFileBytes = 1024;
	if (initialContent !== null) {
		writeFileSync(h.path, initialContent);
	}
	expect(await h.runtime.beforeTool("write", { path: h.path }, h.ctx, "oversized-write")).toBeUndefined();
	writeFileSync(h.path, "x".repeat(1025));
	const result = await h.runtime.boundary(h.ctx, "completed");
	expect(result?.entries?.[0]).toMatchObject({ details: { outcome: "waived" } });
	expect(h.runtime.state).toMatchObject({
		phase: "closed",
		resolution: "waived",
		files: [],
		attempts: 0,
		reviewed: false,
	});
	expect(h.pi.appendEntry).toHaveBeenCalledWith(
		"code-quality:waiver",
		expect.objectContaining({ path: h.path, automatic: true, reviewed: false }),
	);
	expect(h.activityEvents.filter((event) => event.toolCallId === "oversized-write").at(-1)?.phase).toBe(
		"waived",
	);
	expect(h.review).not.toHaveBeenCalled();
	expect(h.ui.coverage).not.toHaveBeenCalled();
	expect(h.ui.failure).not.toHaveBeenCalled();
	expect(h.attentionEvents).toEqual([]);
});

it.each([
	{
		limit: "hunk",
		maxBatchBytes: DEFAULT_CONFIG.maxBatchBytes,
		oversizedText: "x".repeat(DEFAULT_CONFIG.maxInputChars),
	},
	{ limit: "batch", maxBatchBytes: 1024, oversizedText: "x".repeat(1025) },
])(
	"waives a file over the $limit limit while reviewing another file and preserving their distinct badges",
	async ({ maxBatchBytes, oversizedText }) => {
		const h = harness();
		const eligiblePath = join(h.cwd, "small.ts");
		h.runtime.config.maxBatchBytes = maxBatchBytes;
		expect(await h.runtime.beforeTool("write", { path: h.path }, h.ctx, "oversized-write")).toBeUndefined();
		writeFileSync(h.path, oversizedText);
		expect(
			await h.runtime.beforeTool("write", { path: eligiblePath }, h.ctx, "eligible-write"),
		).toBeUndefined();
		writeFileSync(eligiblePath, "const count = 1;");
		const result = await h.runtime.boundary(h.ctx, "completed");
		expect(h.review).toHaveBeenCalledOnce();
		expect(h.review.mock.calls[0]![0].request.files[0].path).toBe(eligiblePath);
		expect(h.runtime.state?.files.map((file) => file.path)).toEqual([eligiblePath]);
		expect(h.runtime.state?.sizeWaivers).toMatchObject([{ path: h.path }]);
		expect(result?.entries?.[0]).toMatchObject({
			details: { outcome: "waived" },
			content: expect.stringContaining("1 oversized file(s) automatically waived"),
		});
		expect(h.activityEvents.filter((event) => event.toolCallId === "oversized-write").at(-1)?.phase).toBe(
			"waived",
		);
		expect(h.activityEvents.filter((event) => event.toolCallId === "eligible-write").at(-1)?.phase).toBe(
			"approved",
		);
		expect(h.ui.coverage).not.toHaveBeenCalled();
		expect(h.ui.failure).not.toHaveBeenCalled();
	},
);

it("automatically waives an initial model-context overflow without calling the provider or failure dialog", async () => {
	const h = harness();
	const complete = vi.fn();
	Object.assign(h.ctx.modelRegistry, {
		find: () => ({ provider: "test", id: "reviewer", contextWindow: 1024, maxTokens: 16_000 }),
		hasConfiguredAuth: () => true,
		complete,
	});
	h.review.mockImplementation(runReview);
	const result = await edit(h, "const count = 1;");
	expect(result?.entries?.[0]).toMatchObject({ details: { outcome: "waived" } });
	expect(h.runtime.state).toMatchObject({
		phase: "closed",
		resolution: "waived",
		attempts: 0,
		reviewed: false,
	});
	expect(complete).not.toHaveBeenCalled();
	expect(h.ui.failure).not.toHaveBeenCalled();
});

it("discards earlier chunk findings for a file waived on a later chunk and still reviews other files", async () => {
	const h = harness();
	const unchangedMiddle = Array.from({ length: 100 }, (_, index) => `const padding${index} = ${index};`).join(
		"\n",
	);
	const before = `x\n${unchangedMiddle}\nx\n`;
	const after = `xx\n${unchangedMiddle}\nxx\n`;
	const groupedChunks = buildReviewChunks([{ path: h.path, before, after }], h.runtime.config, h.cwd);
	h.runtime.config.maxInputChars = 14_000 + Math.ceil(groupedChunks[0]!.input.length * 0.7);
	writeFileSync(h.path, before);
	expect(await h.runtime.beforeTool("write", { path: h.path }, h.ctx)).toBeUndefined();
	writeFileSync(h.path, after);
	const eligiblePath = join(h.cwd, "small.ts");
	expect(await h.runtime.beforeTool("write", { path: eligiblePath }, h.ctx)).toBeUndefined();
	writeFileSync(eligiblePath, "const count = 1;");
	h.review.mockResolvedValueOnce(namingRejection(h.path, "xx"));
	h.review.mockResolvedValueOnce({
		kind: "oversized",
		reason: "Quality verdict repair exceeds the complete-context budget.",
		metrics: { requests: 1, latencyMs: 1, usages: [] },
	});
	h.review.mockResolvedValueOnce(approved());
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.review.mock.calls.map((call) => call[0].request.files[0].path)).toEqual([
		h.path,
		h.path,
		eligiblePath,
	]);
	expect(h.runtime.state?.verdict).toMatchObject({
		verdict: "approved",
		findings: [],
		edits: [],
		proposed: {},
	});
	expect(h.runtime.state?.sizeWaivers).toMatchObject([{ path: h.path }]);
	expect(h.ui.failure).not.toHaveBeenCalled();
	expect(h.ui.arbitrate).not.toHaveBeenCalled();
});

it("keeps a size-waived file excluded while a rejected eligible file uses correction rounds", async () => {
	const h = harness();
	const eligiblePath = join(h.cwd, "small.ts");
	expect(await h.runtime.beforeTool("write", { path: h.path }, h.ctx)).toBeUndefined();
	writeFileSync(h.path, "x".repeat(h.runtime.config.maxInputChars));
	expect(await h.runtime.beforeTool("write", { path: eligiblePath }, h.ctx)).toBeUndefined();
	writeFileSync(eligiblePath, "x");
	h.review.mockResolvedValue(namingRejection(eligiblePath, "x"));
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state).toMatchObject({ phase: "correcting", attempts: 0 });
	expect(h.runtime.state?.sizeWaivers).toMatchObject([{ path: h.path }]);
	await h.runtime.respond(
		{
			action: "disagree",
			caseId: h.runtime.state!.id,
			revision: revision(h.runtime.state!),
			rationale: "This is a coordinate.",
		},
		h.ctx,
	);
	h.review.mockResolvedValueOnce(approved());
	const result = await h.runtime.boundary(h.ctx, "completed");
	expect(h.review.mock.calls.map((call) => call[0].request.files[0].path)).toEqual([
		eligiblePath,
		eligiblePath,
	]);
	expect(h.runtime.state).toMatchObject({ phase: "closed", attempts: 1 });
	expect(result?.entries?.[0]).toMatchObject({ details: { outcome: "waived" } });
});

it("waives a tracked file that grows past the capture limit during review and reviews the remaining file afresh", async () => {
	const h = harness();
	h.runtime.config.maxFileBytes = 1024;
	const eligiblePath = join(h.cwd, "small.ts");
	expect(await h.runtime.beforeTool("write", { path: h.path }, h.ctx)).toBeUndefined();
	writeFileSync(h.path, "const count = 1;");
	expect(await h.runtime.beforeTool("write", { path: eligiblePath }, h.ctx)).toBeUndefined();
	writeFileSync(eligiblePath, "const total = 1;");
	h.review.mockImplementationOnce(async () => {
		writeFileSync(h.path, "x".repeat(1025));
		return approved();
	});
	const stale = await h.runtime.boundary(h.ctx, "completed");
	expect(stale?.entries?.[0]).toMatchObject({ details: { outcome: "stale" } });
	const result = await h.runtime.boundary(h.ctx, "completed");
	expect(h.review.mock.calls.map((call) => call[0].request.files[0].path)).toEqual([h.path, eligiblePath]);
	expect(h.runtime.state?.sizeWaivers).toMatchObject([{ path: h.path }]);
	expect(result?.entries?.[0]).toMatchObject({ details: { outcome: "waived" } });
	expect(h.ui.coverage).not.toHaveBeenCalled();
});

it("reconsiders an earlier size waiver when a later write makes the file reviewable", async () => {
	const h = harness();
	h.runtime.config.maxFileBytes = 1024;
	await edit(h, "x".repeat(1025));
	await edit(h, "const count = 1;");
	expect(h.review).not.toHaveBeenCalled();
	await edit(h, "const count = 2;");
	expect(h.review).toHaveBeenCalledOnce();
	expect(h.runtime.state?.resolution).toBe("model_approved");
	expect(h.runtime.state?.sizeWaivers).toBeUndefined();
});

it("retains pending size waivers across reload while reviewing eligible files", async () => {
	const h = harness();
	h.runtime.config.maxFileBytes = 1024;
	expect(await h.runtime.beforeTool("write", { path: h.path }, h.ctx)).toBeUndefined();
	writeFileSync(h.path, "x".repeat(1025));
	const eligiblePath = join(h.cwd, "small.ts");
	expect(await h.runtime.beforeTool("write", { path: eligiblePath }, h.ctx)).toBeUndefined();
	writeFileSync(eligiblePath, "const count = 1;");
	await h.runtime.boundary(h.ctx, "aborted");
	const restored = new QualityController(h.pi, h.agentDir, { ui: h.ui, review: h.review });
	await restored.start(h.ctx);
	await restored.command("retry", h.ctx);
	const result = await restored.boundary(h.ctx, "completed");
	expect(h.review).toHaveBeenCalledOnce();
	expect(restored.state?.sizeWaivers).toMatchObject([{ path: h.path }]);
	expect(result?.entries?.[0]).toMatchObject({ details: { outcome: "waived" } });
});

it("does not let an oversized review hunk waive blocking LSP diagnostics", async () => {
	const h = harness();
	h.runtime.ports.lsp = {
		revision: 0,
		configRevision: "profile",
		check: vi.fn(async () => ({
			kind: "checked" as const,
			findings: [
				{
					file: h.path,
					serverId: "typescript",
					message: "Resolve this diagnostic",
					severity: 1 as const,
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				},
			],
			generation: "fixture",
			hashes: {},
			workspaceRevision: 0,
			elapsedMs: 1,
		})),
	};
	const result = await edit(h, "x".repeat(h.runtime.config.maxInputChars));
	expect(result?.entries?.[0]).toMatchObject({ details: { outcome: "rejected" } });
	expect(h.runtime.state?.sizeWaivers).toBeUndefined();
	expect(h.runtime.state?.lspWaived).toBeUndefined();
	expect(h.review).not.toHaveBeenCalled();
});

it("keeps known LSP diagnostics pending when correction capture becomes oversized", async () => {
	const h = harness();
	saveConfig(h.agentDir, { maxFileBytes: 1024 });
	h.runtime.config.maxFileBytes = 1024;
	const sibling = join(h.cwd, "sibling.ts");
	const finding = {
		file: h.path,
		serverId: "typescript",
		message: "Known diagnostic",
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
	};
	const check = vi.fn(
		async (): Promise<LspCheckResult> => ({
			kind: "checked",
			findings: [finding],
			hashes: { [h.path]: "hash", [sibling]: "hash" },
			generation: "fixture",
			workspaceRevision: 0,
			elapsedMs: 1,
		}),
	);
	h.runtime.ports.lsp = { revision: 0, configRevision: "profile", check };
	h.ctx.ui.select = vi.fn().mockResolvedValue(undefined);
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "bad");
	await h.runtime.beforeTool("write", { path: sibling }, h.ctx);
	writeFileSync(sibling, "good");
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state?.lsp?.findings).toEqual([finding]);
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "x".repeat(1025));
	check.mockResolvedValue({
		kind: "checked",
		findings: [],
		hashes: { [sibling]: "hash" },
		generation: "fixture",
		workspaceRevision: 0,
		elapsedMs: 1,
	});
	await h.runtime.boundary(h.ctx, "completed");
	expect(check).toHaveBeenCalledOnce();
	expect(h.runtime.state?.lsp?.findings).toEqual([finding]);
	expect(h.runtime.state?.lspCapturePaths).toEqual([h.path]);
	expect(h.runtime.state?.phase).toBe("paused");
	expect(h.review).not.toHaveBeenCalled();
	await h.runtime.command("retry", h.ctx);
	vi.mocked(h.ctx.ui.select).mockResolvedValue("Waive LSP for this case");
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state).toMatchObject({ phase: "closed", lspWaived: true });
	expect(h.review).toHaveBeenCalledOnce();
});

it("retains a failed LSP check when its supported file is subsequently size-waived", async () => {
	const h = harness();
	saveConfig(h.agentDir, { maxFileBytes: 1024 });
	h.runtime.config.maxFileBytes = 1024;
	const check = vi.fn(
		async (): Promise<LspCheckResult> => ({ kind: "unavailable", reason: "Server failed" }),
	);
	h.runtime.ports.lsp = { revision: 0, configRevision: "profile", check };
	h.ctx.ui.select = vi.fn().mockResolvedValue(undefined);
	await edit(h, "source");
	expect(h.runtime.state?.lspUnavailable).toBe("Server failed");
	writeFileSync(h.path, "x".repeat(1025));
	await h.runtime.command("retry", h.ctx);
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state?.lspCapturePaths).toEqual([h.path]);
	expect(h.runtime.state?.phase).toBe("paused");
	expect(h.review).not.toHaveBeenCalled();
});

it("counts an oversized correction as a response even without a changed sibling", async () => {
	const h = harness();
	h.runtime.config.maxFileBytes = 1024;
	const sibling = join(h.cwd, "small.ts");
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "x");
	await h.runtime.beforeTool("write", { path: sibling }, h.ctx);
	writeFileSync(sibling, "x");
	h.review.mockResolvedValue(namingRejection(sibling, "x"));
	await h.runtime.boundary(h.ctx, "completed");
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "x".repeat(1025));
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state?.attempts).toBe(1);
});

it("recovers an oversized diagnostic obligation after reload and external repair", async () => {
	const h = harness();
	saveConfig(h.agentDir, { maxFileBytes: 1024 });
	h.runtime.config.maxFileBytes = 1024;
	const finding = {
		file: h.path,
		serverId: "typescript",
		message: "Known diagnostic",
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
	};
	const check = vi.fn(
		async (): Promise<LspCheckResult> => ({
			kind: "checked",
			findings: [finding],
			hashes: { [h.path]: "hash" },
			generation: "fixture",
			workspaceRevision: 0,
			elapsedMs: 1,
		}),
	);
	h.runtime.ports.lsp = { revision: 0, configRevision: "profile", check };
	h.ctx.ui.select = vi.fn().mockResolvedValue(undefined);
	await edit(h, "bad");
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "x".repeat(1025));
	await h.runtime.boundary(h.ctx, "completed");
	await h.runtime.start(h.ctx);
	expect(h.runtime.state?.lspCapturePaths).toEqual([h.path]);
	writeFileSync(h.path, "fixed");
	check.mockResolvedValue({
		kind: "checked",
		findings: [],
		hashes: { [h.path]: "hash" },
		generation: "fixture",
		workspaceRevision: 0,
		elapsedMs: 1,
	});
	await h.runtime.command("retry", h.ctx);
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state).toMatchObject({ phase: "closed", lspCapturePaths: [], sizeWaivers: [] });
	expect(h.runtime.state?.lspWaived).not.toBe(true);
	expect(check).toHaveBeenCalledTimes(2);
});

it("retires clean supported-source coverage when only Markdown remains after a size waiver", async () => {
	const h = harness();
	const markdown = join(h.cwd, "README.md");
	const hasSupportedSourceFile = (files: { path: string }[]) =>
		files.some(({ path }) => path.endsWith(".ts"));
	const cleanSourceCheck: LspCheckResult = {
		kind: "checked",
		findings: [],
		hashes: { [h.path]: "hash" },
		generation: "fixture",
		workspaceRevision: 0,
		elapsedMs: 1,
	};
	const check = vi.fn(async (files): Promise<LspCheckResult | undefined> => {
		if (hasSupportedSourceFile(files)) {
			return cleanSourceCheck;
		}
		return undefined;
	});
	h.runtime.ports.lsp = { revision: 0, configRevision: "profile", check };
	h.ctx.ui.select = vi.fn();
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "x".repeat(h.runtime.config.maxInputChars));
	await h.runtime.beforeTool("write", { path: markdown }, h.ctx);
	writeFileSync(markdown, "x");
	h.review.mockResolvedValueOnce(namingRejection(markdown, "x"));
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state?.lspRequired).toBe(false);
	await h.runtime.beforeTool("write", { path: markdown }, h.ctx);
	writeFileSync(markdown, "Clear text");
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state?.phase).toBe("closed");
	expect(h.ctx.ui.select).not.toHaveBeenCalled();
});

it("preserves an existing waiver after a blocked edit while paused", async () => {
	const h = harness();
	h.runtime.config.maxFileBytes = 1024;
	writeFileSync(h.path, "x".repeat(1025));
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	const sibling = join(h.cwd, "small.ts");
	await h.runtime.beforeTool("write", { path: sibling }, h.ctx);
	writeFileSync(sibling, "x");
	h.review.mockResolvedValueOnce(namingRejection(sibling, "x"));
	await h.runtime.boundary(h.ctx, "completed");
	h.runtime.state!.phase = "paused";
	expect(await h.runtime.beforeTool("write", { path: h.path }, h.ctx)).toMatchObject({ block: true });
	expect(h.runtime.state?.sizeWaivers).toMatchObject([{ path: h.path }]);
	await h.runtime.command("retry", h.ctx);
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state?.phase).toBe("closed");
	expect(h.runtime.state?.sizeWaivers).toMatchObject([{ path: h.path }]);
});

it("keeps remaining exact operator targets after an application file becomes oversized", async () => {
	const h = harness();
	h.runtime.config.maxFileBytes = 1024;
	const sibling = join(h.cwd, "small.ts");
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "a");
	await h.runtime.beforeTool("write", { path: sibling }, h.ctx);
	writeFileSync(sibling, "b");
	h.review.mockResolvedValueOnce({
		...approved(),
		value: {
			verdict: "needs_work",
			rationale: "Name both",
			findings: [],
			edits: [
				{ file: h.path, oldText: "a", newText: "x".repeat(1025) },
				{ file: sibling, oldText: "b", newText: "count" },
			],
			proposed: { [h.path]: "x".repeat(1025), [sibling]: "count" },
		},
	});
	await h.runtime.boundary(h.ctx, "completed");
	resolveCase(h.runtime.state!, "proposed");
	h.review.mockClear();
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "x".repeat(1025));
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state?.phase).toBe("applying");
	expect(h.runtime.state?.approvedTargets).toEqual({ [sibling]: digest("count") });
	expect(h.review).not.toHaveBeenCalled();
	await h.runtime.command("retry", h.ctx);
	expect(h.runtime.state?.phase).toBe("applying");
	await h.runtime.beforeTool("write", { path: sibling }, h.ctx);
	writeFileSync(sibling, "count");
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.runtime.state).toMatchObject({ phase: "closed", resolution: "user_approved" });
	expect(h.review).not.toHaveBeenCalled();
});

it("drops a queued disagreement when external growth changes the reviewed scope", async () => {
	const h = harness();
	h.runtime.config.maxFileBytes = 1024;
	const sibling = join(h.cwd, "small.ts");
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx);
	writeFileSync(h.path, "x");
	await h.runtime.beforeTool("write", { path: sibling }, h.ctx);
	writeFileSync(sibling, "clear");
	h.review.mockResolvedValueOnce(namingRejection(h.path, "x"));
	await h.runtime.boundary(h.ctx, "completed");
	await disagree(h, "An argument about the old revision");
	writeFileSync(h.path, "x".repeat(1025));
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.review.mock.calls.at(-1)?.[0].request.objection).toBeUndefined();
	expect(h.runtime.state?.attempts).toBe(0);
});

it("does not overwrite an earlier rejected tool badge with a correction size waiver", async () => {
	const h = harness();
	h.runtime.config.maxFileBytes = 1024;
	h.review.mockResolvedValueOnce(namingRejection(h.path, "x"));
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx, "initial");
	writeFileSync(h.path, "x");
	await h.runtime.boundary(h.ctx, "completed");
	await h.runtime.beforeTool("write", { path: h.path }, h.ctx, "correction");
	writeFileSync(h.path, "x".repeat(1025));
	await h.runtime.boundary(h.ctx, "completed");
	expect(h.activityEvents.filter((event) => event.toolCallId === "initial").at(-1)?.phase).toBe("needs_work");
	expect(h.activityEvents.filter((event) => event.toolCallId === "correction").at(-1)?.phase).toBe("waived");
});

it("publishes planning size waivers together without intermediate case snapshots", async () => {
	const h = harness();
	h.runtime.config.maxBatchBytes = 1024;
	const paths = [h.path, join(h.cwd, "b.ts"), join(h.cwd, "c.ts")];
	for (const path of paths) {
		await h.runtime.beforeTool("write", { path }, h.ctx);
		writeFileSync(path, "x".repeat(1025));
	}
	const originalSave = CaseStore.prototype.save;
	const waiverCounts: number[] = [];
	const save = vi.spyOn(CaseStore.prototype, "save").mockImplementation(function (this: CaseStore, state) {
		waiverCounts.push(state.sizeWaivers?.length ?? 0);
		return originalSave.call(this, state);
	});
	try {
		await h.runtime.boundary(h.ctx, "completed");
		expect(waiverCounts.filter((count) => count > 0 && count < paths.length)).toEqual([]);
		expect(waiverCounts).toEqual([0, paths.length, paths.length]);
	} finally {
		save.mockRestore();
	}
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

function reviewerWithOutOfScopeFinding(h: ReturnType<typeof harness>) {
	const complete = vi.fn().mockResolvedValue({
		stopReason: "toolUse",
		content: [
			{
				type: "toolCall",
				name: "submit_quality_verdict",
				arguments: {
					verdict: "needs_work",
					rationale: "Name the coordinate",
					findings: [{ file: h.path, line: 99, quote: "x", rule: "names", rationale: "Name intent" }],
					edits: [{ file: h.path, oldText: "x", newText: "coordinate" }],
				},
			},
		],
	});
	Object.assign(h.ctx.modelRegistry, {
		find: () => ({ provider: "test", id: "reviewer", contextWindow: 100_000, maxTokens: 8000 }),
		hasConfiguredAuth: () => true,
		complete,
	});
	h.review.mockImplementation(runReview);
	return complete;
}

it("pauses an initial review after one failed scope repair without approving", async () => {
	const h = harness();
	const complete = reviewerWithOutOfScopeFinding(h);
	await edit(h, "x");
	expect(complete).toHaveBeenCalledTimes(2);
	expect(h.runtime.state).toMatchObject({ phase: "paused", attempts: 0, reviewed: false });
	expect(h.runtime.state?.resolution).toBeUndefined();
	expect(h.ui.failure).toHaveBeenCalledWith(
		h.ctx,
		expect.stringContaining(
			"Quality verdict invalid after one repair attempt: Finding outside changed scope",
		),
		expect.any(AbortSignal),
	);
	expect(h.ui.arbitrate).not.toHaveBeenCalled();
	expect(h.ctx.abort).toHaveBeenCalled();
	await h.runtime.boundary(h.ctx, "completed", true);
	expect(complete).toHaveBeenCalledTimes(2);
});

it("keeps a disagreement pending after one failed scope repair without spending its round", async () => {
	const h = harness();
	h.review.mockResolvedValueOnce(namingRejection(h.path, "x"));
	await edit(h, "x");
	await disagree(h, "This is a coordinate name.");
	const complete = reviewerWithOutOfScopeFinding(h);
	await h.runtime.boundary(h.ctx, "completed");
	expect(complete).toHaveBeenCalledTimes(2);
	expect(h.runtime.state).toMatchObject({ phase: "paused", attempts: 0, reconsiderationPending: true });
	expect(h.runtime.state?.resolution).toBeUndefined();
	expect(h.ui.failure).toHaveBeenCalledWith(
		h.ctx,
		expect.stringContaining(
			"Quality verdict invalid after one repair attempt: Finding outside changed scope",
		),
		expect.any(AbortSignal),
	);
	expect(h.ui.arbitrate).not.toHaveBeenCalled();
	expect(h.ctx.abort).toHaveBeenCalled();
	await h.runtime.boundary(h.ctx, "completed", true);
	expect(complete).toHaveBeenCalledTimes(2);
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
