import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import extension from "./index.js";
import { uiHarness } from "./ui.test.helpers.js";
import type { Report } from "./types.js";
import { providerUsage } from "./usage.js";
import { saveReport } from "./report.js";
import { testPermissionEvents } from "./test-fixtures.js";
import { PermissionBlocked, PermissionScope } from "./permissions.js";
import { ResultStore } from "./result-store.js";
import * as storage from "./storage.js";
import type { WorkPhase } from "./work-ui.js";
import { discoverSettingsSections } from "@paulsteele/pi-shared-ui";
import * as repositorySetup from "./setup.js";
const state = vi.hoisted(() => ({
	report: undefined as unknown,
	browser: undefined as unknown,
	failViewer: false,
	failSave: false,
	savedReports: [] as Report[],
	validations: 0,
	driftAfter: Infinity,
	captureFailures: 0,
	viewerWait: undefined as Promise<void> | undefined,
	preparationWait: undefined as Promise<void> | undefined,
	preparationStarted: false,
	journalClosed: false,
	journalWait: undefined as Promise<void> | undefined,
	journalStarted: false,
	snapshotCleanupWait: undefined as Promise<void> | undefined,
	snapshotCleanupStarted: false,
	emitProgress: false,
	progressQueued: false,
	onProgressQueued: undefined as (() => void) | undefined,
	progressMessage: "Viewer preparing",
	progressCallback: undefined as ((message: string) => void) | undefined,
	sectionFiles: new Map<string, string>(),
}));
vi.mock("./git.js", async (original) => ({
	...(await original<object>()),
	resolveRepo: async () => ({ root: "/fixture", commonDir: "/fixture/.git", id: "a".repeat(64) }),
}));
vi.mock("./storage.js", async (original) => ({
	...(await original<object>()),
	storageRoot: async () => "/private-runtime",
	storedFileMetadataFingerprint: async (_root: string, path: string) => {
		if (state.sectionFiles.has(path)) {
			return path;
		}
		const report = state.savedReports.at(-1);
		if (!report) {
			return undefined;
		}
		return JSON.stringify(report);
	},
	readStored: async () => {
		const report = state.savedReports.at(-1);
		if (!report) {
			return undefined;
		}
		return { value: structuredClone(report), revision: JSON.stringify(report) };
	},
}));
vi.mock("./snapshot-store.js", async (original) => ({
	...(await original<object>()),
	SnapshotStore: {
		createAtRoot: async () => {
			const paths: string[] = [];
			return {
				put: async (text: string) => {
					const path = `/private-runtime/section-${state.sectionFiles.size}`;
					state.sectionFiles.set(path, text);
					paths.push(path);
					return path;
				},
				dispose: async () => {
					for (const path of paths) {
						state.sectionFiles.delete(path);
					}
				},
			};
		},
	},
	textPage: async (path: string, offset: number, limit: number) => {
		const text = state.sectionFiles.get(path)!;
		return { text: text.slice(offset, offset + limit), total: text.length };
	},
}));
vi.mock("./profile.js", async (original) => ({
	...(await original<object>()),
	loadProfile: async () => ({ profile: { draft: { exclusions: [] } }, revision: "fixture" }),
}));
vi.mock("./config.js", async (original) => ({
	...(await original<object>()),
	loadConfig: async () => ({ provider: "fake", model: "fixture", historyLimit: 20 }),
}));
vi.mock("./snapshot.js", () => ({
	capture: async () => {
		if (state.captureFailures-- > 0) throw new Error("Fixture source temporarily unavailable");
		return {
			changes: [{ file: "a.ts", patch: "fixture" }],
			omitted: [],
			dispose: async () => {
				state.snapshotCleanupStarted = true;
				await state.snapshotCleanupWait;
			},
		};
	},
	assertCurrent: async () => {
		if (++state.validations >= state.driftAfter) throw new Error("fixture source drift");
	},
}));
vi.mock("./runner.js", () => ({
	review: async (options: { permissions: { host(name: string): PermissionScope }; work: WorkPhase }) => {
		await options.work("Reviewing fixture source", () =>
			options.permissions.host("Fixture review source").guard(
				{
					toolName: "read",
					input: { path: "/fixture/a.ts" },
					effects: [{ path: "/fixture/a.ts", side: "new", version: "snapshot" }],
				},
				async () => undefined,
			),
		);
		if (state.preparationWait) {
			state.preparationStarted = true;
			await state.preparationWait;
		}
		return structuredClone(state.report);
	},
}));
vi.mock("./journal.js", () => ({
	createRunJournal: async () => ({
		path: "/private-runtime/progress.json",
		close: async () => {
			state.journalStarted = true;
			await state.journalWait;
			state.journalClosed = true;
		},
	}),
}));
vi.mock("./plannotator.js", () => ({
	installedPlannotator: async () => "/installed",
	present: async (options: { progress: (text: string) => void }) => {
		state.progressCallback = options.progress;
		if (state.emitProgress) {
			options.progress(state.progressMessage);
			state.progressQueued = true;
			state.onProgressQueued?.();
		}
		await state.viewerWait;
		if (state.failViewer) throw new Error("fixture viewer failure");
		return structuredClone(state.browser);
	},
}));
vi.mock("./report.js", async (original) => ({
	...(await original<object>()),
	saveReport: vi.fn(async (_root, report) => {
		if (state.failSave) throw new Error("fixture report save failed");
		state.savedReports.push(structuredClone(report));
	}),
}));
function harness() {
	state.report = {
		version: 1,
		id: "fixture",
		repoId: "a".repeat(64),
		project: "Fixture",
		createdAt: "now",
		scope: { kind: "local" },
		baseline: null,
		head: null,
		fingerprint: "snapshot",
		profileHash: "profile",
		promptHashes: {},
		model: "fake",
		status: "complete",
		lenses: [],
		declined: [],
		clean: [],
		issues: [],
		omitted: [],
		changedFiles: 1,
		findings: [
			{
				id: "F1",
				reviewer: "Security",
				title: "Proposed risky fix",
				severity: "medium",
				file: "a.ts",
				side: "new",
				startLine: 1,
				endLine: 1,
				problem: "Fixture",
				suggestion: "Proposed change",
				rationale: "Fixture",
				evidence: [],
			},
		],
		groups: [["F1"]],
		ledger: [],
		elapsedMs: 0,
		usage: { input: 0, output: 0, cost: 0 },
		tasks: [
			{
				id: "review:security",
				stage: "review",
				name: "Security",
				files: ["a.ts"],
				reason: "fixture",
				state: "completed",
				queuedAt: 0,
				turns: 1,
				requests: 1,
				compactions: 0,
				retries: 0,
				activity: "done",
				updatedAt: 1,
				usage: { input: 0, output: 0, cost: 0 },
			},
		],
	} satisfies Report;
	state.failViewer = false;
	state.failSave = false;
	state.savedReports = [];
	state.validations = 0;
	state.driftAfter = Infinity;
	vi.mocked(saveReport).mockClear();
	state.captureFailures = 0;
	state.viewerWait = undefined;
	state.preparationWait = undefined;
	state.preparationStarted = false;
	state.journalClosed = false;
	state.journalWait = undefined;
	state.journalStarted = false;
	state.snapshotCleanupWait = undefined;
	state.snapshotCleanupStarted = false;
	state.emitProgress = false;
	state.progressQueued = false;
	state.onProgressQueued = undefined;
	state.progressMessage = "Viewer preparing";
	state.progressCallback = undefined;
	state.sectionFiles.clear();
	const ui = uiHarness();
	const ctx = {
		cwd: "/fixture",
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "review-session" },
		ui: ui.ui,
		modelRegistry: { find: () => ({}), hasConfiguredAuth: () => true },
	} as unknown as ExtensionContext;
	let command: any;
	const tools = new Map<string, any>();
	const events = new Map<string, () => void>();
	const permissionEvents = testPermissionEvents();
	const settingsSubscribers = new Map<string, Set<(value: unknown) => void>>();
	const api = {
		events: {
			on(name: string, handler: (value: unknown) => void) {
				const listeners = settingsSubscribers.get(name) ?? new Set();
				listeners.add(handler);
				settingsSubscribers.set(name, listeners);
				return () => listeners.delete(handler);
			},
			emit: vi.fn((name: string, data: unknown) => {
				permissionEvents.emit(name, data);
				for (const listener of settingsSubscribers.get(name) ?? []) {
					listener(data);
				}
			}),
		},
		on(name: string, handler: () => void) {
			events.set(name, handler);
		},
		registerCommand(_name: string, value: unknown) {
			command = value;
		},
		registerTool(value: { name: string }) {
			tools.set(value.name, value);
		},
		sendMessage: vi.fn(),
	};
	extension(api as unknown as ExtensionAPI);
	return {
		api,
		ctx,
		command,
		tool: tools.get("pr_review"),
		resultTool: tools.get("pr_review_result"),
		ui,
		events,
	};
}
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
it.each(["command", "tool"])(
	"revokes persisted fix IDs after late drift during the final %s permission wait",
	async (entry) => {
		const h = harness();
		state.browser = { decision: "feedback", requestedIds: ["F1"], discussion: [], feedback: "Fix F1" };
		let blocked = true,
			waiting = false;
		const original = PermissionScope.prototype.authorizeSources;
		vi.spyOn(PermissionScope.prototype, "authorizeSources").mockImplementation(async function (
			this: PermissionScope,
			sources,
			description,
			signal,
		) {
			if (description === "Return the authorized review result to the parent" && blocked) {
				waiting = true;
				throw new PermissionBlocked("denied", "Output permission denied");
			}
			return original.call(this, sources, description, signal);
		});
		let toolResult: any;
		const pending =
			entry === "tool"
				? h.tool
						.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx)
						.then((result: unknown) => {
							toolResult = result;
						})
				: h.command.handler("", h.ctx);
		await vi.waitFor(() => expect(waiting).toBe(true));
		expect(state.validations).toBe(1);
		expect(state.savedReports.at(-1)?.browser?.requestedIds).toEqual(["F1"]);
		state.driftAfter = 2;
		blocked = false;
		await h.command.handler("retry", h.ctx);
		await pending;
		if (entry === "command") await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalledOnce());
		const text = entry === "tool" ? toolResult.content[0].text : h.api.sendMessage.mock.calls[0]![0].content;
		expect(text).toContain("NO FIXES AUTHORIZED");
		expect(text).toContain("Requested verified finding IDs: []");
		expect(text).toContain("Audit report (optional; no filesystem read required):");
		expect(state.savedReports.at(-1)).toMatchObject({
			status: "incomplete",
			browser: { decision: "feedback", requestedIds: [] },
		});
		expect(state.savedReports.at(-1)?.issues.join(" ")).toContain("fixture source drift");
		const retrieved = await h.resultTool.execute(
			"read-drifted-result",
			{ reportId: "fixture", section: "action" },
			new AbortController().signal,
			undefined,
			h.ctx,
		);
		expect(JSON.parse(JSON.parse(retrieved.content[0].text).text).browser.requestedIds).toEqual([]);
	},
);

it.each(
	["command", "tool"].flatMap((entry) =>
		["publication", "handoff"].flatMap((stage) =>
			["retry", "cancel"].map((control) => ({ entry, stage, control })),
		),
	),
)("keeps status usable for $entry $stage output recovery ($control)", async ({ entry, stage, control }) => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	let blocked = true,
		waiting = false;
	const original = PermissionScope.prototype.authorizeSources;
	vi.spyOn(PermissionScope.prototype, "authorizeSources").mockImplementation(async function (
		this: PermissionScope,
		sources,
		description,
		signal,
	) {
		const matches =
			stage === "handoff"
				? description === "Return the authorized review result to the parent"
				: description.startsWith("Publish captured/");
		if (matches && blocked) {
			waiting = true;
			throw new PermissionBlocked("denied", "Output permission denied");
		}
		return original.call(this, sources, description, signal);
	});
	const pending =
		entry === "tool"
			? h.tool
					.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx)
					.catch((error: unknown) => error)
			: h.command.handler("", h.ctx);
	await vi.waitFor(() => expect(waiting).toBe(true));
	h.ui.state.active?.handleInput?.("cancel-key");
	await h.command.handler("status", h.ctx);
	await vi.waitFor(() => expect(h.ui.state.active).toBeDefined());
	expect(h.ui.state.active!.render(120).join("\n")).toContain(
		stage === "handoff" ? "Authorize parent output" : "Authorize output",
	);
	expect(h.ui.state.notifications.some((note) => note.message.includes("suspended while approval"))).toBe(
		false,
	);
	blocked = false;
	await h.command.handler(control, h.ctx);
	await pending;
	if (entry === "command") await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalledOnce());
});

it("shows parent-output source progress after journal work finishes before final authorization", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	let checking = false;
	let release!: () => void;
	const approval = new Promise<void>((resolve) => {
		release = resolve;
	});
	const original = PermissionScope.prototype.guard;
	vi.spyOn(PermissionScope.prototype, "guard").mockImplementation(async function (
		this: PermissionScope,
		action,
		read,
	) {
		if (action.description === "Return the authorized review result to the parent") {
			checking = true;
			await approval;
		}
		return original.call(this, action, read);
	});
	const pending = h.tool.execute("fixture", {}, new AbortController().signal, undefined, h.ctx);
	try {
		await vi.waitFor(() => expect(checking).toBe(true));
		await vi.waitFor(() => {
			const text = h.ui.state.active?.render(120).join("\n");
			expect(text).toContain("Authorize parent output");
			expect(text).toContain("Parent output: 0/1 source checks complete");
			expect(text).toContain("/fixture/a.ts");
		});
		expect(state.journalClosed).toBe(true);
		expect(h.api.sendMessage).not.toHaveBeenCalled();
	} finally {
		release();
		await pending;
	}
	expect(state.journalClosed).toBe(true);
});

it("cancels the initial sandbox source probe before opening permissions or starting a second probe", async () => {
	const h = harness();
	let finishProbe!: () => void;
	const probeWait = new Promise<void>((resolve) => {
		finishProbe = resolve;
	});
	const authorizeHostSource = vi.fn((_path: string, _signal?: AbortSignal) => probeWait);
	const originalEmit = h.api.events.emit.getMockImplementation()!;
	h.api.events.emit.mockImplementation((name, data) => {
		if (name === "sandbox:service:v1") {
			(data as { accept(value: unknown): void }).accept({ authorizeHostSource });
			return;
		}
		originalEmit(name, data);
	});
	const pending = h.tool.execute("fixture", {}, new AbortController().signal, undefined, h.ctx);
	const cancelled = expect(pending).rejects.toThrow();
	try {
		await vi.waitFor(() => expect(authorizeHostSource).toHaveBeenCalledOnce());
		const [path, probeSignal] = authorizeHostSource.mock.calls[0]!;
		expect(path).toBe("/fixture");
		await h.command.handler("cancel", h.ctx);
		await cancelled;
		expect(probeSignal!.aborted).toBe(true);
		expect(authorizeHostSource).toHaveBeenCalledOnce();
		expect(state.savedReports).toEqual([]);
	} finally {
		finishProbe();
	}
});

it("shows and cancels the owned work presenter for settings-launched repository setup", async () => {
	const h = harness();
	const pendingSetup = vi
		.spyOn(repositorySetup, "setup")
		.mockImplementation(
			async (_context, _repository, _rootPath, abortSignal, reportProgress, runOwnedWork) => {
				return runOwnedWork!("Generating setup context", async () => {
					reportProgress("Discovering fixture sources");
					return new Promise<string>((_resolve, reject) => {
						abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
					});
				});
			},
		);
	const prSettingsSection = discoverSettingsSections(h.api).find((section) => section.id === "pr")!;
	const repositorySetupAction = prSettingsSection.actions!.find(
		(settingsAction) => settingsAction.id === "setup-create",
	)!;
	const pending = repositorySetupAction.run(h.ctx, new AbortController().signal);
	const cancelled = expect(pending).rejects.toThrow();
	await vi.waitFor(() =>
		expect(h.ui.state.active?.render(100).join("\n")).toContain("Discovering fixture sources"),
	);
	h.ui.state.active!.handleInput!("cancel-key");
	await cancelled;
	expect(h.ui.state.active).toBeUndefined();
	expect(pendingSetup).toHaveBeenCalledOnce();
});

it.each(["command", "tool"])(
	"cancels %s handoff while final journal publication is pending",
	async (entry) => {
		const h = harness();
		state.browser = { decision: "feedback", requestedIds: ["F1"], discussion: [], feedback: "Fix F1" };
		let release!: () => void;
		state.journalWait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending =
			entry === "tool"
				? h.tool
						.execute("fixture", {}, new AbortController().signal, undefined, h.ctx)
						.catch((error: unknown) => error)
				: h.command.handler("", h.ctx);
		await vi.waitFor(() => expect(state.journalStarted).toBe(true));
		await h.command.handler("cancel", h.ctx);
		release();
		await pending;
		if (entry === "command") {
			await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalledOnce());
			expect(h.api.sendMessage.mock.calls[0]![0].content).toContain("cancelled");
		}
		await expect(
			h.resultTool.execute(
				"read",
				{ reportId: "fixture", section: "action" },
				new AbortController().signal,
				undefined,
				h.ctx,
			),
		).rejects.toThrow("Unknown or expired");
	},
);

it("withholds fixes when source changes while snapshot cleanup is pending", async () => {
	const h = harness();
	state.browser = { decision: "feedback", requestedIds: ["F1"], discussion: [], feedback: "Fix F1" };
	let releaseCleanup!: () => void;
	state.snapshotCleanupWait = new Promise<void>((resolve) => {
		releaseCleanup = resolve;
	});
	const pending = h.tool.execute("fixture", {}, new AbortController().signal, undefined, h.ctx);
	try {
		await vi.waitFor(() => expect(state.snapshotCleanupStarted).toBe(true));
		state.driftAfter = 2;
	} finally {
		releaseCleanup();
	}
	const result = await pending;
	expect(result.content[0].text).toContain("NO FIXES AUTHORIZED");
	expect(state.savedReports.at(-1)?.browser?.requestedIds).toEqual([]);
});

it.each(["command", "tool"])("registers only the saved report before the %s handoff", async (entry) => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "Explain F1" };
	let path: string;
	if (entry === "tool") {
		const result = await h.tool.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx);
		path = result.details.path;
	} else {
		await h.command.handler("", h.ctx);
		await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalledOnce());
		path = h.api.sendMessage.mock.calls[0]![0].details.path;
		expect(h.api.events.emit.mock.invocationCallOrder[0]).toBeLessThan(
			h.api.sendMessage.mock.invocationCallOrder[0]!,
		);
	}
	expect(
		h.api.events.emit.mock.calls.filter(([name]) => name === "permissions:allow_session_files"),
	).toHaveLength(1);
	expect(h.api.events.emit).toHaveBeenCalledWith("permissions:allow_session_files", {
		version: 1,
		sessionId: "review-session",
		paths: [path],
	});
	expect(path).toBe(`/private-runtime/repos/${"a".repeat(64)}/reports/fixture.json`);
	expect(vi.mocked(saveReport).mock.invocationCallOrder.at(-1)).toBeLessThan(
		h.api.events.emit.mock.invocationCallOrder.at(-1)!,
	);
});
it("does not register a report when persistence fails", async () => {
	const h = harness();
	state.failSave = true;
	await expect(h.tool.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx)).rejects.toThrow(
		"fixture report save failed",
	);
	expect(
		h.api.events.emit.mock.calls.filter(([name]) => name === "permissions:allow_session_files"),
	).toHaveLength(0);
});
it("keeps the review result if optional permission integration fails", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	h.api.events.emit.mockImplementation((name, data) => {
		if (name === "permissions:allow_session_files") throw new Error("fixture listener failure");
		testPermissionEvents().emit(name, data);
	});
	const result = await h.tool.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx);
	expect(result.details.path).toContain("/reports/fixture.json");
	expect(result.content[0].text).toContain("NO FIXES AUTHORIZED");
});
it("returns complete nested usage to the parent tool without zeroing cache counters", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	const measured = {
		input: 3,
		output: 5,
		cacheRead: 10000,
		cacheWrite: 1000,
		totalTokens: 11008,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
	};
	(state.report as Report).usage = providerUsage(measured, "first");
	const result = await h.tool.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx);
	expect(result.usage).toEqual(measured);
	expect(result.content[0].text).toContain("10000 cache read");
});
it.each(["cancel", "session_shutdown", "session_tree"])(
	"does not deliver queued progress after %s while work is still settling",
	async (action) => {
		vi.useFakeTimers();
		const h = harness(),
			outer = new AbortController(),
			onUpdate = vi.fn();
		let release!: () => void;
		state.viewerWait = new Promise((resolve) => {
			release = resolve;
		});
		state.emitProgress = true;
		state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
		const ready = new Promise<void>((resolve) => {
			state.onProgressQueued = resolve;
		});
		const pending = h.tool.execute("fixture", {}, outer.signal, onUpdate, h.ctx).then(
			() => false,
			() => true,
		);
		try {
			await ready;
			if (action === "cancel") await h.command.handler("cancel", h.ctx);
			else h.events.get(action)!();
			state.progressCallback?.("Late viewer URL must not appear");
			await vi.advanceTimersByTimeAsync(500);
			expect(outer.signal.aborted).toBe(false);
			expect(onUpdate).not.toHaveBeenCalled();
			expect(h.ui.state.notifications.some((note) => note.message.includes("Late viewer"))).toBe(false);
		} finally {
			release();
		}
		expect(await pending).toBe(true);
		expect(
			h.api.events.emit.mock.calls.filter(([name]) => name === "permissions:allow_session_files"),
		).toHaveLength(0);
	},
);
it("releases Pi's serial command loop so status opens before browser feedback", async () => {
	vi.useFakeTimers();
	const h = harness(),
		url = "http://127.0.0.1:19432";
	let release!: () => void;
	state.viewerWait = new Promise((resolve) => {
		release = resolve;
	});
	state.emitProgress = true;
	state.progressMessage = `Review findings in Plannotator: ${url}`;
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	const ready = new Promise<void>((resolve) => {
		state.onProgressQueued = resolve;
	});
	// Mirror Pi's idle loop: the next command cannot run until the previous handler returns.
	let queue = Promise.resolve();
	const processed: string[] = [];
	const send = (args: string) => {
		queue = queue.then(async () => {
			await h.command.handler(args, h.ctx);
			processed.push(args);
		});
		return queue;
	};
	void send("");
	try {
		await ready;
		expect(processed).toContain("");
		await vi.advanceTimersByTimeAsync(100);
		expect(h.ui.state.frames.some((frame) => frame.includes(url))).toBe(true);
		expect(h.ui.state.notifications.some((note) => note.message.includes(url))).toBe(true);
		expect(h.api.sendMessage).not.toHaveBeenCalled();
		h.ui.state.active!.handleInput!("cancel-key");
		await vi.advanceTimersByTimeAsync(100);
		expect(h.ui.state.widgets.get("pr-review")?.join("\n")).toContain(url);
		await send("status");
		await vi.advanceTimersByTimeAsync(0);
		expect(processed).toContain("status");
		expect(h.ui.state.active?.render(120).join("\n")).toContain(url);
		expect(h.api.sendMessage).not.toHaveBeenCalled();
		await send(""); // A second review must not replace the still-active first operation.
		expect(h.ui.state.notifications.some((note) => note.message.includes("already active"))).toBe(true);
	} finally {
		release();
		await queue;
	}
	await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalledOnce());
	expect(h.ui.state.active).toBeUndefined();
	await send("status");
	await vi.advanceTimersByTimeAsync(0);
	expect(h.ui.state.active?.render(120).join("\n")).toContain("Review complete");
	expect(h.ui.state.active?.render(120).join("\n")).not.toContain("Waiting for Plannotator feedback");
	h.events.get("session_shutdown")!();
});
it.each(["command", "tool"])(
	"keeps /pr status available for a %s review preparing the next phase",
	async (entry) => {
		const h = harness();
		state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
		let release!: () => void;
		state.preparationWait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending =
			entry === "tool"
				? h.tool.execute("fixture", {}, new AbortController().signal, undefined, h.ctx)
				: h.command.handler("", h.ctx);
		try {
			await vi.waitFor(() => expect(state.preparationStarted).toBe(true));
			expect(h.ui.state.active?.render(120).join("\n")).toContain("Reviewing fixture source");
			h.ui.state.active!.handleInput!("cancel-key");
			expect(h.ui.state.active).toBeUndefined();
			await h.command.handler("status", h.ctx);
			await vi.waitFor(() => expect(h.ui.state.active).toBeDefined());
			expect(h.ui.state.notifications).toEqual([]);
			expect(h.api.sendMessage).not.toHaveBeenCalled();
			await h.command.handler("", h.ctx);
			expect(h.ui.state.notifications.at(-1)?.message).toContain("already active");
		} finally {
			release();
			await pending;
		}
		if (entry === "command") {
			await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalledOnce());
		}
		expect(h.ui.state.active).toBeUndefined();
		expect(h.ui.state.factories).toBe(h.ui.state.closes);
	},
);

it("does not publish a detached command result or viewer URL into a retired session", async () => {
	vi.useFakeTimers();
	const h = harness();
	let release!: () => void;
	state.viewerWait = new Promise((resolve) => {
		release = resolve;
	});
	state.emitProgress = true;
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	const ready = new Promise<void>((resolve) => {
		state.onProgressQueued = resolve;
	});
	await h.command.handler("", h.ctx);
	await ready;
	h.events.get("session_shutdown")!();
	state.progressCallback?.("Late browser URL");
	release();
	await vi.advanceTimersByTimeAsync(0);
	expect(h.api.sendMessage).not.toHaveBeenCalled();
	expect(
		h.api.events.emit.mock.calls.filter(([name]) => name === "permissions:allow_session_files"),
	).toHaveLength(0);
	expect(h.ui.state.notifications.some((note) => note.message.includes("Late browser"))).toBe(false);
	await h.command.handler("status", h.ctx);
	expect(h.ui.state.notifications.at(-1)?.message).toContain("No review task history");
	expect(vi.getTimerCount()).toBe(0);
});
it("keeps the review tool awaited while exposing live browser progress and status", async () => {
	vi.useFakeTimers();
	const h = harness(),
		onUpdate = vi.fn(),
		url = "http://127.0.0.1:19433";
	h.ctx.isIdle = () => false;
	let release!: () => void,
		settled = false;
	state.viewerWait = new Promise((resolve) => {
		release = resolve;
	});
	state.emitProgress = true;
	state.progressMessage = `Review findings in Plannotator: ${url}`;
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	const ready = new Promise<void>((resolve) => {
		state.onProgressQueued = resolve;
	});
	const pending = h.tool
		.execute("fixture", {}, new AbortController().signal, onUpdate, h.ctx)
		.then((result: unknown) => {
			settled = true;
			return result;
		});
	try {
		await ready;
		await vi.advanceTimersByTimeAsync(100);
		expect(settled).toBe(false);
		expect(onUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ content: [{ type: "text", text: expect.stringContaining(url) }] }),
		);
		h.ui.state.active!.handleInput!("cancel-key");
		await h.command.handler("status", h.ctx);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.ui.state.active?.render(120).join("\n")).toContain(url);
		expect(settled).toBe(false);
	} finally {
		release();
		await pending;
	}
	expect(settled).toBe(true);
});
it.each(["lgtm", "dismissed", "failure"])(
	"preserves no-fix authorization in the actual %s tool result",
	async (decision) => {
		const h = harness();
		state.browser = { decision, requestedIds: [], discussion: [], feedback: "" };
		state.failViewer = decision === "failure";
		const result = await h.tool.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx);
		expect(result.content[0].text).toContain("NO FIXES AUTHORIZED");
		expect(result.content[0].text).toContain("Requested verified finding IDs: []");
		expect(result.content[0].text).toContain("Proposed risky fix");
	},
);
it("allows status/retry during an agent-invoked review without rerunning completed stages", async () => {
	const h = harness();
	state.captureFailures = 1;
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	h.ctx.isIdle = () => false;
	const pending = h.tool.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx);
	await vi.waitFor(() => expect(h.ui.state.frames.some((frame) => frame.includes("Blocked"))).toBe(true));
	await h.command.handler("status", h.ctx);
	await h.command.handler("retry", h.ctx);
	const result = await pending;
	expect(result.content[0].text).toContain("NO FIXES AUTHORIZED");
	expect(h.ui.state.active).toBeUndefined();
});
it("cancels a blocked tool review through the command without an idle session", async () => {
	const h = harness();
	state.captureFailures = 1;
	h.ctx.isIdle = () => false;
	const pending = expect(
		h.tool.execute("fixture", {}, new AbortController().signal, () => {}, h.ctx),
	).rejects.toThrow();
	await vi.waitFor(() => expect(h.ui.state.frames.some((frame) => frame.includes("Blocked"))).toBe(true));
	await h.command.handler("cancel", h.ctx);
	await pending;
	expect(h.ui.state.active).toBeUndefined();
});
it("triggers discussion for command approval notes without authorizing fixes", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "Please explain F1." };
	await h.command.handler("", h.ctx);
	await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalled());
	expect(h.api.sendMessage).toHaveBeenCalledWith(
		expect.objectContaining({ content: expect.stringContaining("NO FIXES AUTHORIZED") }),
		{ triggerTurn: true },
	);
	expect(h.api.sendMessage.mock.calls[0]![0].content).toContain("browser.feedback");
});
it("returns scoped retrieval instructions for an oversized command action", async () => {
	const h = harness();
	state.browser = {
		decision: "lgtm",
		requestedIds: [],
		discussion: [],
		feedback: "LGTM - no changes requested.",
	};
	(state.report as Report).issues = ["long report\n".repeat(12000)];
	await h.command.handler("", h.ctx);
	await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalled());
	const text = h.api.sendMessage.mock.calls[0]![0].content;
	expect(text).toContain('"actionComplete":false');
	expect(text).toContain("pr_review_result");
	expect(text).toContain("NO FIXES AUTHORIZED");
	expect(text).toMatch(/Audit report .*\/reports\/fixture\.json/);
	expect(h.api.sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: false });
});

it.each(["command", "tool"])(
	"publishes the same complete action data through %s and scoped retrieval",
	async (entry) => {
		const h = harness();
		state.browser = {
			decision: "feedback",
			requestedIds: ["F1"],
			discussion: [{ id: "reply", text: "Keep the public API." }],
			feedback: "Fix F1 without changing exports.",
		};
		let text: string;
		if (entry === "command") {
			await h.command.handler("", h.ctx);
			await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalledOnce());
			text = h.api.sendMessage.mock.calls[0]![0].content;
		} else {
			const result = await h.tool.execute("review", {}, new AbortController().signal, undefined, h.ctx);
			text = result.content[0].text;
			expect(result.details.actionComplete).toBe(true);
			expect(result.details.retrievalTool).toBe("pr_review_result");
		}
		const inline = JSON.parse(text.split("# Action payload\n")[1]!.split("\n")[0]!);
		const result = await h.resultTool.execute(
			"read",
			{ reportId: "fixture", section: "action" },
			new AbortController().signal,
			undefined,
			h.ctx,
		);
		const page = JSON.parse(result.content[0].text);
		expect(page.nextOffset).toBeNull();
		expect(JSON.parse(page.text)).toEqual(inline);
		expect(inline.browser.feedback).toBe("Fix F1 without changing exports.");
		expect(inline.browser.discussion).toEqual([{ id: "reply", text: "Keep the public API." }]);
		expect(inline.browser.requestedIds).toEqual(["F1"]);
	},
);

it.each(["session_start", "session_shutdown", "session_tree"])(
	"expires published report retrieval on %s",
	async (event) => {
		const h = harness();
		state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
		await h.tool.execute("review", {}, new AbortController().signal, undefined, h.ctx);
		h.events.get(event)!();
		await expect(
			h.resultTool.execute(
				"read",
				{ reportId: "fixture", section: "action" },
				new AbortController().signal,
				undefined,
				h.ctx,
			),
		).rejects.toThrow("Unknown or expired");
	},
);

it("denies report retrieval in a different session without discovering a permission service", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	await h.tool.execute("review", {}, new AbortController().signal, undefined, h.ctx);
	h.api.events.emit.mockClear();
	h.ctx.sessionManager.getSessionId = () => "replacement-session";
	await expect(
		h.resultTool.execute(
			"read",
			{ reportId: "fixture", section: "action" },
			new AbortController().signal,
			undefined,
			h.ctx,
		),
	).rejects.toThrow("Unknown or expired");
	expect(h.api.events.emit).not.toHaveBeenCalled();
});

it("checks retained source dependencies on every retrieval and attaches the actual parent tool ID", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	await h.tool.execute("review", {}, new AbortController().signal, undefined, h.ctx);
	const authorize = vi.spyOn(PermissionScope.prototype, "authorizeSources");
	const open = vi.fn((_options: { parentToolCallId: string }) => ({
		task: () => ({
			check: async () => ({ kind: "allowed", revision: "live" }),
			revision: () => "live",
			nextTurn() {},
			endTurn() {},
			close() {},
		}),
		close() {},
	}));
	h.api.events.emit.mockImplementation((name, raw) => {
		if (name === "permissions:review-service:v1") {
			(raw as { accept(value: unknown): void }).accept({ version: 1, open });
		}
	});
	await h.resultTool.execute(
		"read-one",
		{ reportId: "fixture", section: "action" },
		new AbortController().signal,
		undefined,
		h.ctx,
	);
	await h.resultTool.execute(
		"read-two",
		{ reportId: "fixture", section: "report" },
		new AbortController().signal,
		undefined,
		h.ctx,
	);
	expect(open.mock.calls.map(([options]) => options.parentToolCallId)).toEqual(["read-one", "read-two"]);
	expect(authorize).toHaveBeenCalledTimes(2);
	for (const [dependencies, description] of authorize.mock.calls) {
		expect(dependencies).toEqual([{ path: "/fixture/a.ts", side: "new", version: "snapshot" }]);
		expect(description).toBe("Disclose saved PR result to the parent");
	}
});

it.each(["denied", "unavailable"])(
	"does not disclose report data after a %s live permission check",
	async (kind) => {
		const h = harness();
		state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
		await h.tool.execute("review", {}, new AbortController().signal, undefined, h.ctx);
		const closeTask = vi.fn();
		const closeOperation = vi.fn();
		h.api.events.emit.mockImplementation((name, raw) => {
			if (name === "permissions:review-service:v1") {
				(raw as { accept(value: unknown): void }).accept({
					version: 1,
					open: () => ({
						task: () => ({
							check: async () => ({ kind, reason: "Fixture live policy blocked disclosure" }),
							revision: () => "live",
							nextTurn() {},
							endTurn() {},
							close: closeTask,
						}),
						close: closeOperation,
					}),
				});
			}
		});
		await expect(
			h.resultTool.execute(
				"read",
				{ reportId: "fixture", section: "action" },
				new AbortController().signal,
				undefined,
				h.ctx,
			),
		).rejects.toThrow("Fixture live policy blocked disclosure");
		expect(closeTask).toHaveBeenCalledOnce();
		expect(closeOperation).toHaveBeenCalledOnce();
	},
);

it("blocks retrieval when the compatible permission service disappears", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	await h.tool.execute("review", {}, new AbortController().signal, undefined, h.ctx);
	h.api.events.emit.mockImplementation(() => {});
	await expect(
		h.resultTool.execute(
			"read",
			{ reportId: "fixture", section: "action" },
			new AbortController().signal,
			undefined,
			h.ctx,
		),
	).rejects.toThrow("requires the loaded compatible Devcontainer Sandbox");
});

it.each([
	{
		trigger: "tool abort",
		cancel: ({ controller }: { controller: AbortController; h: ReturnType<typeof harness> }) =>
			controller.abort(),
	},
	{
		trigger: "session tree change",
		cancel: ({ h }: { controller: AbortController; h: ReturnType<typeof harness> }) =>
			h.events.get("session_tree")!(),
	},
])("cancels pending retrieval after a $trigger and closes its permission operation", async ({ cancel }) => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	await h.tool.execute("review", {}, new AbortController().signal, undefined, h.ctx);
	const controller = new AbortController();
	const closeOperation = vi.fn();
	let checking = false;
	h.api.events.emit.mockImplementation((name, raw) => {
		if (name === "permissions:review-service:v1") {
			(raw as { accept(value: unknown): void }).accept({
				version: 1,
				open: () => ({
					task: () => ({
						check: async (request: { signal: AbortSignal }) => {
							checking = true;
							await new Promise<void>((resolve) =>
								request.signal.addEventListener("abort", () => resolve(), { once: true }),
							);
							return { kind: "cancelled", reason: "Fixture retrieval cancelled" };
						},
						revision: () => "live",
						nextTurn() {},
						endTurn() {},
						close() {},
					}),
					close: closeOperation,
				}),
			});
		}
	});
	const pending = h.resultTool.execute(
		"read",
		{ reportId: "fixture", section: "action" },
		controller.signal,
		undefined,
		h.ctx,
	);
	const rejected = expect(pending).rejects.toThrow("Permission review cancelled.");
	await vi.waitFor(() => expect(checking).toBe(true));
	cancel({ controller, h });
	await rejected;
	expect(closeOperation).toHaveBeenCalledOnce();
});

it("rechecks source policy after saved-file work and rejects a new denial", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	await h.tool.execute("review", {}, new AbortController().signal, undefined, h.ctx);
	let denied = false;
	const close = vi.fn();
	h.api.events.emit.mockImplementation((name, raw) => {
		if (name === "permissions:review-service:v1") {
			(raw as { accept(value: unknown): void }).accept({
				version: 1,
				open: () => ({
					task: () => ({
						check: async () => {
							if (denied) {
								return { kind: "denied", reason: "Source now denied" };
							}
							return { kind: "allowed", revision: "allowed" };
						},
						revision: () => (denied ? "denied" : "allowed"),
						nextTurn() {},
						endTurn() {},
						close() {},
					}),
					close,
				}),
			});
		}
	});
	const original = ResultStore.prototype.page;
	vi.spyOn(ResultStore.prototype, "page").mockImplementation(async function (this: ResultStore, ...args) {
		const text = await original.apply(this, args);
		denied = true;
		return text;
	});
	await expect(
		h.resultTool.execute(
			"read",
			{ reportId: "fixture", section: "action" },
			new AbortController().signal,
			undefined,
			h.ctx,
		),
	).rejects.toThrow("Source now denied");
	expect(close).toHaveBeenCalledOnce();
});

it("restarts a complete source-authorization pass when the live revision changes", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	await h.tool.execute("review", {}, new AbortController().signal, undefined, h.ctx);
	let revision = "old";
	const checked: string[] = [];
	h.api.events.emit.mockImplementation((name, raw) => {
		if (name === "permissions:review-service:v1") {
			(raw as { accept(value: unknown): void }).accept({
				version: 1,
				open: () => ({
					task: () => ({
						check: async () => {
							checked.push(revision);
							const checkedRevision = revision;
							revision = "new";
							return { kind: "allowed", revision: checkedRevision };
						},
						revision: () => revision,
						nextTurn() {},
						endTurn() {},
						close() {},
					}),
					close() {},
				}),
			});
		}
	});
	const result = await h.resultTool.execute(
		"read",
		{ reportId: "fixture", section: "action" },
		new AbortController().signal,
		undefined,
		h.ctx,
	);
	const authorizationRevisions = ["old", "new", "new"];
	expect(checked).toEqual(authorizationRevisions);
	expect(JSON.parse(JSON.parse(result.content[0].text).text).reportId).toBe("fixture");
});

it("does not leave a retrievable report when command result publication fails", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	h.api.sendMessage.mockImplementationOnce(() => {
		throw new Error("Fixture result publication failed");
	});
	await h.command.handler("", h.ctx);
	await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalledTimes(2));
	await expect(
		h.resultTool.execute(
			"read",
			{ reportId: "fixture", section: "action" },
			new AbortController().signal,
			undefined,
			h.ctx,
		),
	).rejects.toThrow("Unknown or expired");
});

it("pages a large command action to completion through the result tool", async () => {
	const h = harness();
	const feedback = "Preserve the API. 😀 ".repeat(6000);
	state.browser = { decision: "feedback", requestedIds: ["F1"], discussion: [], feedback };
	await h.command.handler("", h.ctx);
	await vi.waitFor(() => expect(h.api.sendMessage).toHaveBeenCalledOnce());
	expect(h.api.sendMessage.mock.calls[0]![0].details.actionComplete).toBe(false);
	expect(h.api.sendMessage.mock.calls[0]![0].content).toContain("pr_review_result");
	const fragments: string[] = [];
	let cursor: number | null = 0;
	while (cursor !== null) {
		const result = await h.resultTool.execute(
			"read",
			{ reportId: "fixture", section: "action", cursor },
			new AbortController().signal,
			undefined,
			h.ctx,
		);
		const page = JSON.parse(result.content[0].text);
		fragments.push(page.text);
		cursor = page.nextOffset;
	}
	const action = JSON.parse(fragments.join(""));
	expect(action.browser.feedback).toBe(feedback);
	expect(action.browser.requestedIds).toEqual(["F1"]);
	expect(action.findings.map((finding: { id: string }) => finding.id)).toEqual(["F1"]);
});

it.each(["session_tree", "session_shutdown"])(
	"rejects a tool producer retired at final publication by %s",
	async (event) => {
		const h = harness();
		state.browser = { decision: "feedback", requestedIds: ["F1"], discussion: [], feedback: "Fix F1" };
		const caller = new AbortController();
		const emit = h.api.events.emit.getMockImplementation()!;
		h.api.events.emit.mockImplementation((name, data) => {
			emit(name, data);
			if (name === "permissions:allow_session_files") {
				queueMicrotask(() => h.events.get(event)!());
			}
		});
		await expect(h.tool.execute("review", {}, caller.signal, undefined, h.ctx)).rejects.toThrow(
			"operation was aborted",
		);
		expect(caller.signal.aborted).toBe(false);
		await expect(
			h.resultTool.execute(
				"read",
				{ reportId: "fixture", section: "action" },
				new AbortController().signal,
				undefined,
				h.ctx,
			),
		).rejects.toThrow("Unknown or expired");
	},
);

it("rejects tool publication after the original session identity changes", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "" };
	const emit = h.api.events.emit.getMockImplementation()!;
	h.api.events.emit.mockImplementation((name, data) => {
		emit(name, data);
		if (name === "permissions:allow_session_files") {
			queueMicrotask(() => {
				h.ctx.sessionManager.getSessionId = () => "replacement";
			});
		}
	});
	await expect(h.tool.execute("review", {}, new AbortController().signal, undefined, h.ctx)).rejects.toThrow(
		"retired session generation",
	);
});

it.each([
	{
		mutation: "deletion",
		expectedError: "unavailable",
		mutate: () => {
			state.savedReports = [];
		},
	},
	{
		mutation: "replacement",
		expectedError: "Saved review report changed",
		mutate: () => {
			state.savedReports.at(-1)!.status = "incomplete";
		},
	},
])("rejects backing $mutation during a renewed disclosure approval", async ({ mutate, expectedError }) => {
	const h = harness();
	state.browser = { decision: "feedback", requestedIds: ["F1"], discussion: [], feedback: "Fix F1" };
	await h.tool.execute("review", {}, new AbortController().signal, undefined, h.ctx);
	let revision = "initial";
	let waiting = false;
	let release!: () => void;
	const approval = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.api.events.emit.mockImplementation((name, raw) => {
		if (name === "permissions:review-service:v1") {
			(raw as { accept(value: unknown): void }).accept({
				version: 1,
				open: () => ({
					task: () => ({
						check: async () => {
							if (revision === "renewed") {
								waiting = true;
								await approval;
							}
							return { kind: "allowed", revision };
						},
						revision: () => revision,
						nextTurn() {},
						endTurn() {},
						close() {},
					}),
					close() {},
				}),
			});
		}
	});
	const page = ResultStore.prototype.page;
	vi.spyOn(ResultStore.prototype, "page").mockImplementation(async function (this: ResultStore, ...args) {
		const result = await page.apply(this, args);
		revision = "renewed";
		return result;
	});
	const pending = h.resultTool.execute(
		"read",
		{ reportId: "fixture", section: "action" },
		new AbortController().signal,
		undefined,
		h.ctx,
	);
	const rejected = expect(pending).rejects.toThrow(expectedError);
	await vi.waitFor(() => expect(waiting).toBe(true));
	mutate();
	release();
	await rejected;
});

it("materializes result sections only once across actual tool page calls", async () => {
	const h = harness();
	state.browser = {
		decision: "feedback",
		requestedIds: ["F1"],
		discussion: [],
		feedback: "Long feedback. ".repeat(7000),
	};
	await h.tool.execute("review", {}, new AbortController().signal, undefined, h.ctx);
	const reads = vi.spyOn(storage, "readStored");
	let cursor: number | null = 0;
	let pages = 0;
	while (cursor !== null) {
		const result: { content: [{ text: string }] } = await h.resultTool.execute(
			"read",
			{ reportId: "fixture", section: "action", cursor },
			new AbortController().signal,
			undefined,
			h.ctx,
		);
		cursor = JSON.parse(result.content[0].text).nextOffset;
		pages++;
	}
	expect(pages).toBeGreaterThan(10);
	expect(reads).toHaveBeenCalledOnce();
	expect(state.sectionFiles.size).toBe(2);
});
