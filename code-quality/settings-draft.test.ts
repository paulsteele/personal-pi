import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverSettingsSections } from "@paulsteele/pi-shared-ui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerQualityGate } from "./index.js";
import type { LspManager } from "./lsp-manager.js";
import {
	approveLspDraft,
	loadLspDraft,
	loadLspProfile,
	lspProfilePath,
	publishLspJson,
	resolveLspProject,
	saveLspDraft,
} from "./lsp-profile.js";
import { digest } from "./proposal.js";
import { saveConfig } from "./config.js";

const approveSetup = vi.hoisted(() => vi.fn());
vi.mock("./lsp-sandbox-setup.js", () => ({ setupSandboxLsp: approveSetup }));

const directories: string[] = [];
beforeEach(() => {
	approveSetup.mockReset();
});
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function settingsFixture(options: { initialStartupFailure?: boolean } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "quality-settings-draft-"));
	directories.push(directory);
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	await mkdir(cwd);
	if (options.initialStartupFailure) {
		saveConfig(agentDir, { provider: "fixture", model: "reviewer" });
	}
	const entries: unknown[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const listeners = new Map<string, Set<(event: unknown) => void>>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		events: {
			on(name: string, listener: (event: unknown) => void) {
				const subscribers = listeners.get(name) ?? new Set();
				subscribers.add(listener);
				listeners.set(name, subscribers);
				return () => subscribers.delete(listener);
			},
			emit(name: string, event: unknown) {
				if (name === "sandbox:service:v1") {
					(event as { accept(value: unknown): void }).accept({ session: { filesystem: {
						canonical: async (path: string) => resolve(cwd, path),
						read: (path: string) => readFile(path),
						stat: async (path: string) => {
							try {
								return { file: true, size: (await stat(path)).size };
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code === "ENOENT") {
									throw new Error("FileNotFoundError");
								}
								throw error;
							}
						},
					} } });
				}
				for (const listener of listeners.get(name) ?? []) {
					listener(event);
				}
			},
		},
		appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ type: "custom", customType, data })),
		sendMessage: vi.fn(),
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		registerTool() {},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	const manager = {
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		header: [],
		statusText: () => "fixture",
		restart: vi.fn(async () => {}),
		check: vi.fn(async () => ({
			kind: "checked" as const, findings: [], hashes: {}, workspaceRevision: 0, generation: "fixture", elapsedMs: 1,
		})),
		revision: 0,
		configRevision: "fixture",
	} as unknown as LspManager;
	if (options.initialStartupFailure) {
		vi.mocked(manager.start).mockRejectedValueOnce(new Error("Initial LSP startup failed"));
	}
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "session", getBranch: () => entries },
		modelRegistry: {},
		ui: { setStatus: vi.fn(), notify: vi.fn(), select: vi.fn(async () => "Retry LSP check") },
		abort: vi.fn(),
	} as unknown as ExtensionContext;
	const review = vi.fn(async () => ({
		kind: "verdict" as const,
		value: { verdict: "approved" as const, rationale: "Readable", findings: [], edits: [], proposed: {} },
		metrics: { requests: 1, latencyMs: 1, usages: [] },
	}));
	registerQualityGate(pi, {
		review,
		ui: { coverage: async () => undefined, failure: async () => undefined, arbitrate: async () => undefined },
		createLspManager: () => manager,
	}, agentDir);
	await handlers.get("session_start")!({}, ctx);
	const project = await resolveLspProject(cwd, agentDir);
	const profile = { version: 1 as const, projectId: project.id, enabled: true, routes: [] };
	const section = discoverSettingsSections(pi).find((section) => section.id === "lsp")!;
	return { agentDir, project, profile, section, ctx, manager, handlers, review };
}

it("replaces a rejected startup barrier when the quality recovery flow retries LSP", async () => {
	const fixture = await settingsFixture({ initialStartupFailure: true });
	const path = join(fixture.ctx.cwd, "app.ts");
	expect(await fixture.handlers.get("tool_call")!({ toolName: "write", toolCallId: "write", input: { path } }, fixture.ctx)).toBeUndefined();
	await writeFile(path, "const value = 1;\n");
	const retry = await fixture.handlers.get("turn_end")!({ outcome: "completed" }, fixture.ctx);
	expect(retry).toMatchObject({ entries: [{ details: { outcome: "retrying" } }] });
	expect(fixture.manager.restart).toHaveBeenCalledOnce();
	expect(fixture.manager.start).toHaveBeenCalledTimes(2);
	expect(fixture.manager.check).not.toHaveBeenCalled();
	const approved = await fixture.handlers.get("turn_end")!({ outcome: "completed" }, fixture.ctx);
	expect(approved).toMatchObject({ entries: [{ details: { outcome: "approved" } }] });
	expect(fixture.manager.check).toHaveBeenCalledOnce();
	expect(fixture.review).toHaveBeenCalledOnce();
	await fixture.handlers.get("session_shutdown")!({}, fixture.ctx);
});

it("keeps the editable draft usable after validation fails and a corrected Apply succeeds", async () => {
	const fixture = await settingsFixture();
	const draft = await fixture.section.load(fixture.ctx);
	approveSetup.mockRejectedValueOnce(new Error("Diagnostic validation failed"));
	await expect(draft.apply({ ...draft.value, mode: "explicit" })).rejects.toThrow("Diagnostic validation failed");
	approveSetup.mockImplementationOnce(async () => {
		const pending = (await loadLspDraft(fixture.agentDir, fixture.project))!;
		return approveLspDraft(fixture.agentDir, fixture.project, pending.revision);
	});
	await draft.apply({ ...draft.value, mode: "auto" });
	expect((await loadLspProfile(fixture.agentDir, fixture.project))!.profile.mode).toBe("auto");
	expect(approveSetup).toHaveBeenCalledTimes(2);
});

it("refuses another Apply after an external writer changes the draft during failed validation", async () => {
	const fixture = await settingsFixture();
	const draft = await fixture.section.load(fixture.ctx);
	approveSetup.mockImplementationOnce(async () => {
		const pending = (await loadLspDraft(fixture.agentDir, fixture.project))!;
		await saveLspDraft(fixture.agentDir, fixture.project, { ...fixture.profile, enabled: false }, null, pending.revision);
		throw new Error("Diagnostic validation failed");
	});
	await expect(draft.apply(draft.value)).rejects.toThrow("Diagnostic validation failed");
	await expect(draft.apply({ ...draft.value, mode: "explicit" })).rejects.toThrow("changed since preview");
	expect((await loadLspDraft(fixture.agentDir, fixture.project))!.draft.profile.enabled).toBe(false);
	expect(approveSetup).toHaveBeenCalledOnce();
});

it("preserves the pending draft's null base revision when an active profile appears before loading Settings", async () => {
	const fixture = await settingsFixture();
	await saveLspDraft(fixture.agentDir, fixture.project, fixture.profile, null, null);
	const activeProfile = { ...fixture.profile, enabled: false };
	await publishLspJson(lspProfilePath(fixture.agentDir, fixture.project), {
		profile: activeProfile, approvedDigest: digest(JSON.stringify(activeProfile)),
	}, undefined);
	const draft = await fixture.section.load(fixture.ctx);
	approveSetup.mockResolvedValueOnce(undefined);
	await expect(draft.apply({ ...draft.value, mode: "explicit" })).rejects.toThrow("cancelled");
	const pending = (await loadLspDraft(fixture.agentDir, fixture.project))!;
	expect(pending.draft.baseRevision).toBeNull();
	expect(pending.draft.profile).toMatchObject({ enabled: true, mode: "explicit" });
	await expect(approveLspDraft(fixture.agentDir, fixture.project, pending.revision)).rejects.toThrow("changed since preview");
	expect((await loadLspProfile(fixture.agentDir, fixture.project))!.profile.enabled).toBe(false);
});
