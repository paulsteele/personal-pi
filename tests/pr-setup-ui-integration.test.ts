import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import permissionSystem from "../pi-permission-system/src/permission-system.ts";
import prReview from "../pr-review/index.ts";
import { fixture, put, testDraft } from "../pr-review/test-fixtures.ts";
import { uiHarness } from "../pr-review/ui.test.helpers.ts";

for (const cancelStage of [undefined, "setup:discovery", "setup:profile"]) {
	test(`setup entry yields its spinner to real manual permissions (${cancelStage ?? "approve"})`, async () => {
		const previous = process.env.PI_CODING_AGENT_DIR;
		const agentDir = await mkdtemp(join(tmpdir(), "pr-setup-permission-ui-"));
		const repo = await fixture();
		const handlers = new Map<
			string,
			Array<(event: any, ctx: any) => unknown>
		>();
		const listeners = new Map<string, Set<(value: any) => void>>();
		const commands = new Map<string, any>(),
			messages: any[] = [];
		const events = {
			on(name: string, callback: (value: any) => void) {
				const set = listeners.get(name) ?? new Set();
				set.add(callback);
				listeners.set(name, set);
				return () => {
					set.delete(callback);
				};
			},
			emit(name: string, value: unknown) {
				for (const callback of listeners.get(name) ?? []) callback(value);
			},
		};
		const api = {
			events,
			on(name: string, handler: (event: any, ctx: any) => unknown) {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			registerCommand: (name: string, value: any) => commands.set(name, value),
			registerShortcut() {},
			registerTool() {},
			registerEntryRenderer() {},
			appendEntry() {},
			sendMessage: (message: unknown) => messages.push(message),
		};
		const model = {
			provider: "fake",
			id: "test",
			api: "openai-responses",
			reasoning: false,
			contextWindow: 100000,
			maxTokens: 2000,
		};
		const phases = new Map<string, number>();
		let classifierCalls = 0;
		const registry = {
			getAvailable: () => [model],
			find: () => model,
			hasConfiguredAuth: () => true,
			complete: async () => {
				classifierCalls++;
				throw new Error("Auto mode must remain off");
			},
			getApiKeyAndHeaders: async () => ({ ok: true }),
			getProvider: () => ({
				streamSimple: (_model: unknown, context: any) => {
					const input = JSON.parse(
						context.messages.find((message: any) => message.role === "user")
							.content[0].text,
					);
					const stage = input.discovery ? "profile" : "discovery",
						turn = phases.get(stage) ?? 0;
					phases.set(stage, turn + 1);
					const call =
						turn === 0
							? { name: "read", arguments: { path: "AGENTS.md" } }
							: {
									name: "submit_result",
									arguments:
										stage === "discovery"
											? {
													notes: "Fixture",
													sources: ["AGENTS.md"],
													questions: [],
												}
											: { ...testDraft, requiredReading: ["AGENTS.md"] },
								};
					const stream = createAssistantMessageEventStream();
					const message = {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						timestamp: 0,
						stopReason: "toolUse",
						content: [{ type: "toolCall", id: `${stage}-${turn}`, ...call }],
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
					};
					stream.push({
						type: "done",
						reason: "toolUse",
						message: message as never,
					});
					return stream;
				},
			}),
		};
		const h = uiHarness();
		const ctx = {
			cwd: repo.root,
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			isProjectTrusted: () => true,
			ui: h.ui,
			modelRegistry: registry,
			sessionManager: {
				getSessionId: () => "setup-ui",
				getBranch: () => [],
				appendCustomEntry() {},
			},
		};
		let taskId = "",
			driver: ReturnType<typeof setInterval> | undefined;
		const prompted = new Set<string>();
		events.on("permissions:ui_prompt", (event) => {
			taskId = event.delegated?.taskId ?? "";
			prompted.add(taskId);
		});
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			await put(repo.root, "AGENTS.md", "Repository guidance fixture\n");
			await put(
				agentDir,
				"extensions/pi-permission-system/config.json",
				JSON.stringify({
					permission: { "*": "allow", read: "ask" },
					auto: { provider: "fake", model: "test", enabledByDefault: false },
				}),
			);
			permissionSystem(api as never);
			prReview(api as never);
			for (const handler of handlers.get("session_start") ?? [])
				await handler({}, ctx);
			driver = setInterval(() => {
				if (!h.state.active?.render(120).join("\n").includes("Human decision"))
					return;
				if (cancelStage && taskId === cancelStage)
					void commands.get("pr").handler("cancel", ctx);
				else h.state.active.handleInput?.("y");
			}, 1);
			await commands.get("pr").handler("setup", ctx);
			const draftPath = join(
				agentDir,
				"extensions/pr-review/repos",
				repo.id,
				"profile-draft.json",
			);
			if (cancelStage) {
				expect(messages.at(-1)?.content).toContain("cancelled");
				await expect(readFile(draftPath)).rejects.toBeDefined();
			} else {
				expect(
					JSON.parse(await readFile(draftPath, "utf8")).requiredReading,
				).toEqual(["AGENTS.md"]);
				expect(prompted.has("setup:discovery")).toBe(true);
				expect(prompted.has("setup:profile")).toBe(true);
				expect(phases.get("discovery")).toBe(2);
				expect(phases.get("profile")).toBe(2);
			}
			expect(classifierCalls).toBe(0);
			expect(h.state.active).toBeUndefined();
			expect(h.state.factories).toBe(h.state.closes);
		} finally {
			clearInterval(driver);
			for (const handler of handlers.get("session_shutdown") ?? [])
				await handler({}, ctx);
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(repo.root, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		}
	}, 30000);
}
