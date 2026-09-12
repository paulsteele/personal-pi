import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import extension from "./index.js";
import { uiHarness } from "./ui.test.helpers.js";
import type { Report } from "./types.js";
const state = vi.hoisted(() => ({
	report: undefined as unknown,
	browser: undefined as unknown,
	failViewer: false,
}));
vi.mock("./git.js", async (original) => ({
	...(await original<object>()),
	resolveRepo: async () => ({ root: "/fixture", commonDir: "/fixture/.git", id: "a".repeat(64) }),
}));
vi.mock("./storage.js", async (original) => ({
	...(await original<object>()),
	storageRoot: async () => "/private-runtime",
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
	capture: async () => ({ changes: [{ file: "a.ts", patch: "fixture" }] }),
	assertCurrent: async () => {},
}));
vi.mock("./runner.js", () => ({ review: async () => structuredClone(state.report) }));
vi.mock("./plannotator.js", () => ({
	installedPlannotator: async () => "/installed",
	present: async () => {
		if (state.failViewer) throw new Error("fixture viewer failure");
		return structuredClone(state.browser);
	},
}));
vi.mock("./report.js", async (original) => ({ ...(await original<object>()), saveReport: async () => {} }));
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
	} satisfies Report;
	state.failViewer = false;
	const ui = uiHarness();
	const ctx = {
		cwd: "/fixture",
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		isProjectTrusted: () => true,
		ui: ui.ui,
		modelRegistry: { find: () => ({}), hasConfiguredAuth: () => true },
	} as unknown as ExtensionContext;
	let command: any, tool: any;
	const api = {
		on() {},
		registerCommand(_name: string, value: unknown) {
			command = value;
		},
		registerTool(value: unknown) {
			tool = value;
		},
		sendMessage: vi.fn(),
	};
	extension(api as unknown as ExtensionAPI);
	return { api, ctx, command, tool };
}
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
it("triggers discussion for command approval notes without authorizing fixes", async () => {
	const h = harness();
	state.browser = { decision: "lgtm", requestedIds: [], discussion: [], feedback: "Please explain F1." };
	await h.command.handler("", h.ctx);
	expect(h.api.sendMessage).toHaveBeenCalledWith(
		expect.objectContaining({ content: expect.stringContaining("NO FIXES AUTHORIZED") }),
		{ triggerTurn: true },
	);
	expect(h.api.sendMessage.mock.calls[0]![0].content).toContain("browser.feedback");
});
it("retains a visible report locator for a truncated command result", async () => {
	const h = harness();
	state.browser = {
		decision: "lgtm",
		requestedIds: [],
		discussion: [],
		feedback: "LGTM - no changes requested.",
	};
	(state.report as Report).issues = ["long report\n".repeat(12000)];
	await h.command.handler("", h.ctx);
	const text = h.api.sendMessage.mock.calls[0]![0].content;
	expect(text).toContain("Display truncated");
	expect(text).toContain("NO FIXES AUTHORIZED");
	expect(text).toMatch(/Full structured report: .*\/reports\/fixture\.json$/);
	expect(h.api.sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: false });
});
