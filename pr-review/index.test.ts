import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import extension from "./index.js";
import { fixture, put, testDraft } from "./test-fixtures.js";
import { uiHarness } from "./ui.test.helpers.js";
import { DiscoverySubmission } from "./types.js";
import { runWorker } from "./worker.js";
vi.mock("./worker.js", () => ({ runWorker: vi.fn() }));

const dirs: string[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
	vi.resetAllMocks();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
function harness() {
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const tools: Array<{ name: string }> = [];
	const events = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		registerCommand: (name: string, command: unknown) => commands.set(name, command as never),
		registerTool: (tool: { name: string }) => tools.push(tool),
		on: (name: string, handler: (...args: any[]) => unknown) => events.set(name, handler),
		sendMessage: vi.fn(),
		getCommands: vi.fn(() => []),
	};
	extension(pi as unknown as ExtensionAPI);
	return { commands, tools, events, pi };
}
async function interactive() {
	const repo = await fixture();
	dirs.push(repo.root);
	const agentDir = await mkdtemp(join(tmpdir(), "pr-command-agent-"));
	dirs.push(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const ui = uiHarness();
	const ctx = {
		cwd: repo.root,
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		isProjectTrusted: () => true,
		ui: ui.ui,
		modelRegistry: { getAvailable: () => [{ provider: "fake", id: "independent", reasoning: false }] },
	} as unknown as ExtensionContext;
	return { ...harness(), ...ui, repo, agentDir, ctx };
}
async function reviewCommand(h: Awaited<ReturnType<typeof interactive>>, args: string) {
	const before = h.pi.sendMessage.mock.calls.length;
	await h.commands.get("pr")!.handler(args, h.ctx);
	await vi.waitFor(() => expect(h.pi.sendMessage.mock.calls.length).toBeGreaterThan(before));
}
it("registers only the unified command and review tool, without startup work", async () => {
	const h = harness();
	expect([...h.commands.keys()]).toEqual(["pr"]);
	expect(h.tools.map((tool) => tool.name)).toEqual(["pr_review"]);
	expect([...h.events.keys()]).toEqual(["session_shutdown", "session_tree"]);
	const ctx = { mode: "rpc", hasUI: true, ui: { notify: vi.fn() } } as unknown as ExtensionContext;
	await h.commands.get("pr")!.handler("setup", ctx);
	expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "warning");
});
it("rejects bare --base before opening a spinner or invoking Git/model work", async () => {
	const h = await interactive();
	await reviewCommand(h, "--base");
	expect(h.state.factories).toBe(0);
	expect(h.pi.sendMessage).toHaveBeenCalledWith(
		expect.objectContaining({ display: true, content: expect.stringContaining("Missing base reference") }),
		{ triggerTurn: false },
	);
	expect(runWorker).not.toHaveBeenCalled();
});
it.each(["", "--base main"])(
	"reports missing approved context visibly for /pr %s and closes all spinners",
	async (args) => {
		const h = await interactive();
		await reviewCommand(h, args);
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				display: true,
				content: expect.stringContaining("No approved repository review context"),
			}),
			{ triggerTurn: false },
		);
		expect(h.state.factories).toBe(h.state.closes);
		expect(h.state.active).toBeUndefined();
		expect(runWorker).not.toHaveBeenCalled();
	},
);
it("creates a draft with small interview dialogs, then approves it through a model-free command", async () => {
	const h = await interactive();
	await put(h.repo.root, "AGENTS.md", "Fixture rules\n");
	vi.mocked(runWorker).mockImplementation((async (options: {
		schema: unknown;
		progress?: (text: string) => void;
	}) => {
		expect(h.state.active).toBeDefined();
		options.progress?.("read: AGENTS.md");
		const value =
			options.schema === DiscoverySubmission
				? {
						notes: "Fixture",
						sources: ["AGENTS.md"],
						questions: [{ question: "Fixture convention?", options: ["First", "Second"] }],
					}
				: { ...testDraft, requiredReading: ["AGENTS.md"], freshnessSources: ["AGENTS.md"] };
		return { ok: true, value, usage: { input: 0, output: 0, cost: 0 } };
	}) as typeof runWorker);
	await h.commands.get("pr")!.handler("setup", h.ctx);
	expect(h.state.nativeDialogs).toContain("Independent PR review model");
	expect(h.state.nativeDialogs).toContain("Fixture convention?");
	expect(h.state.nativeDialogs).not.toContain("Activate this generated review context?");
	expect(h.state.nativeDialogs.some((title) => title.includes("inspect or edit"))).toBe(false);
	expect(h.state.frames.some((frame) => frame.includes("read: AGENTS.md"))).toBe(true);
	expect(h.state.factories).toBe(h.state.closes);
	expect(h.state.active).toBeUndefined();
	const path = join(h.agentDir, "extensions", "pr-review", "repos", h.repo.id, "profile.json");
	await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
	expect(h.pi.sendMessage).toHaveBeenLastCalledWith(
		expect.objectContaining({ content: expect.stringContaining("profile-draft.json") }),
		expect.anything(),
	);
	await h.commands.get("pr")!.handler("setup approve", h.ctx);
	expect(runWorker).toHaveBeenCalledTimes(2);
	expect(JSON.parse(await readFile(path, "utf8")).repoId).toBe(h.repo.id);
	expect(h.pi.sendMessage).toHaveBeenCalledWith(
		expect.objectContaining({ content: expect.stringContaining("Saved generated PR review context") }),
		expect.anything(),
	);
});
it("explains incomplete setup and does not mistake a saved model for an approved profile", async () => {
	const h = await interactive();
	vi.mocked(runWorker).mockResolvedValue({
		ok: false,
		error: "Worker deadline exhausted",
		usage: { input: 0, output: 0, cost: 0 },
	});
	await h.commands.get("pr")!.handler("setup", h.ctx);
	expect(h.pi.sendMessage).toHaveBeenLastCalledWith(
		expect.objectContaining({ content: expect.stringContaining("Repository discovery failed") }),
		{ triggerTurn: false },
	);
	expect(
		JSON.parse(await readFile(join(h.agentDir, "extensions", "pr-review", "config.json"), "utf8")).model,
	).toBe("independent");
	await expect(
		readFile(join(h.agentDir, "extensions", "pr-review", "repos", h.repo.id, "profile.json")),
	).rejects.toMatchObject({ code: "ENOENT" });
	await reviewCommand(h, "");
	expect(h.pi.sendMessage).toHaveBeenLastCalledWith(
		expect.objectContaining({ content: expect.stringContaining("No approved repository review context") }),
		{ triggerTurn: false },
	);
	expect(runWorker).toHaveBeenCalledTimes(1);
	expect(h.state.active).toBeUndefined();
	expect(h.state.factories).toBe(h.state.closes);
});

it("cancels on session shutdown and does not publish into the replacement session", async () => {
	const h = await interactive();
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let finish!: (value: unknown) => void;
	vi.mocked(runWorker).mockImplementation(() => {
		entered();
		return new Promise((resolve) => {
			finish = (value) => resolve(value as never);
		});
	});
	const pending = h.commands.get("pr")!.handler("setup", h.ctx);
	await started;
	h.events.get("session_shutdown")!();
	await pending;
	expect(h.state.active).toBeUndefined();
	expect(h.pi.sendMessage).not.toHaveBeenCalled();
	finish({ ok: false, error: "cancelled", usage: { input: 0, output: 0, cost: 0 } });
	await Promise.resolve();
	await Promise.resolve();
	expect(h.pi.sendMessage).not.toHaveBeenCalled();
});
