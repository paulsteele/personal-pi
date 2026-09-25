import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import permissionSystem from "../pi-permission-system/src/permission-system.ts";
import {
	openReviewPermissions,
	WORKER_CONTROL_TOOLS,
} from "../pr-review/permissions.ts";
import { capture, snapshotTools } from "../pr-review/snapshot.ts";
import { runWorker } from "../pr-review/worker.ts";
import { ReviewSubmission } from "../pr-review/types.ts";
import {
	createReviewDashboard,
	trackPermissionPrompts,
} from "../pr-review/dashboard.ts";
import { TaskStore } from "../pr-review/tasks.ts";
import { uiHarness } from "../pr-review/ui.test.helpers.ts";
import {
	fixture,
	put,
	commit,
	testConfig,
} from "../pr-review/test-fixtures.ts";

/** Real owner + event-bus client + snapshot + Agent loop. Only the model providers are fake. */
test("PR uses live parent permissions without copying its authority across workers", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await mkdtemp(join(tmpdir(), "pr-permission-integration-"));
	const repo = await fixture();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const events = {
		on(name: string, handler: (data: unknown) => void) {
			const set = listeners.get(name) ?? new Set();
			set.add(handler);
			listeners.set(name, set);
			return () => {
				set.delete(handler);
			};
		},
		emit(name: string, value: unknown) {
			for (const handler of listeners.get(name) ?? []) handler(value);
		},
	};
	const api = {
		events,
		on: (name: string, handler: (event: any, ctx: any) => unknown) =>
			handlers.set(name, handler),
		registerCommand() {},
		registerShortcut() {},
		registerEntryRenderer() {},
		appendEntry() {},
		exec: async () => ({ code: 0, stdout: "" }),
	};
	const classifierInputs: string[] = [],
		workerInputs: string[] = [];
	const model = {
		provider: "fake",
		id: "test",
		api: "openai-responses",
		reasoning: false,
		contextWindow: 100000,
		maxTokens: 2000,
	};
	let turn = 0;
	const registry = {
		find: () => model,
		hasConfiguredAuth: () => true,
		complete: async (_model: unknown, context: unknown) => {
			classifierInputs.push(JSON.stringify(context));
			return {
				content: [
					{
						type: "toolCall",
						name: "submit_verdict",
						arguments: { verdict: "allow" },
					},
				],
			};
		},
		getApiKeyAndHeaders: async () => ({ ok: true }),
		getProvider: () => ({
			streamSimple: (_model: unknown, context: unknown) => {
				workerInputs.push(JSON.stringify(context));
				const call =
					turn++ === 0
						? { name: "read", arguments: { path: "public.ts" } }
						: {
								name: "submit_result",
								arguments: { complete: true, findings: [], limitations: [] },
							};
				const stream = createAssistantMessageEventStream();
				const message = {
					role: "assistant",
					api: model.api,
					model: model.id,
					provider: model.provider,
					timestamp: Date.now(),
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: `call-${turn}`, ...call }],
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
	const ctx = {
		cwd: repo.root,
		mode: "rpc",
		hasUI: true,
		modelRegistry: registry,
		sessionManager: {
			getSessionId: () => "integration",
			getBranch: () => [],
			appendCustomEntry() {},
		},
		ui: {
			setStatus() {},
			notify() {},
			select: async () => "n deny",
			input: async () => undefined,
		},
	};
	let snapshot: Awaited<ReturnType<typeof capture>> | undefined;
	let permissions: ReturnType<typeof openReviewPermissions> | undefined;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await put(repo.root, "public.ts", "before\n");
		await put(repo.root, "private.ts", "PRIVATE_SOURCE_SENTINEL\n");
		await commit(repo.root);
		await put(repo.root, "public.ts", "PUBLIC_REVIEW_SENTINEL\n");
		const configDir = join(agentDir, "extensions", "pi-permission-system");
		await mkdir(configDir, { recursive: true });
		const configPath = join(configDir, "config.json");
		const config = {
			permission: { "*": "ask", path: { "*": "allow", "private.ts": "deny" } },
			auto: {
				provider: "fake",
				model: "test",
				enabledByDefault: true,
				timeoutMs: 1000,
				contextUserTurns: 3,
			},
		};
		await writeFile(configPath, JSON.stringify(config));
		permissionSystem(api as never);
		await handlers.get("session_start")?.({}, ctx);
		permissions = openReviewPermissions(
			api as never,
			ctx as never,
			repo,
			"local",
			new AbortController().signal,
			{ command: "/pr" },
		);
		snapshot = await capture(
			repo,
			{ kind: "local" },
			testConfig,
			permissions.host("Capture"),
		);
		const tools = [
			...snapshotTools(snapshot).map((tool) => tool.name),
			...WORKER_CONTROL_TOOLS,
		];
		const spec = {
			name: "Reviewer",
			assignment: "Review the change and its callers",
			model: "fake/test",
			tools,
			kind: "worker" as const,
		};
		const a = permissions.task({ ...spec, id: "a" }),
			b = permissions.task({ ...spec, id: "b" });
		const aView = snapshot.withPermissions!(a),
			bView = snapshot.withPermissions!(b);
		a.nextTurn();
		b.nextTurn();
		const initialCalls = classifierInputs.length;
		await aView.read("public.ts");
		await aView.read("public.ts");
		expect(classifierInputs.length - initialCalls).toBe(1);
		await bView.read("public.ts");
		expect(classifierInputs.length - initialCalls).toBe(2);
		expect(classifierInputs.join("\n")).toContain("User invoked /pr");
		expect(classifierInputs.join("\n")).toContain("accessed path:");
		expect(classifierInputs.join("\n")).not.toContain("PUBLIC_REVIEW_SENTINEL");
		await expect(aView.read("private.ts")).rejects.toThrow(
			"Denied by permission policy",
		);
		const result = await runWorker({
			registry: registry as never,
			config: testConfig,
			permissions: a,
			schema: ReviewSubmission,
			system: "Review fixture",
			input: { task: "Read public.ts" },
			tools: snapshotTools(aView),
		});
		expect(result.ok).toBe(true);
		expect(workerInputs.join("\n")).toContain("PUBLIC_REVIEW_SENTINEL");
		expect(workerInputs.join("\n")).not.toContain("PRIVATE_SOURCE_SENTINEL");
		await writeFile(
			configPath,
			JSON.stringify({
				...config,
				permission: { "*": "ask", path: { "*": "deny" } },
			}),
		);
		await expect(aView.read("public.ts")).rejects.toThrow(
			"Denied by permission policy",
		);
		await expect(a.beforeDispatch()).rejects.toThrow(
			"Denied by permission policy",
		);
		const c = permissions.task({ ...spec, id: "c" });
		const beforeTransfer = workerInputs.length;
		const transfer = await runWorker({
			registry: registry as never,
			config: testConfig,
			permissions: c,
			schema: ReviewSubmission,
			system: "Verifier",
			input: { quote: "PUBLIC_REVIEW_SENTINEL" },
			dependencies: a.dependencies,
		});
		expect(transfer).toMatchObject({ ok: false, permissionFailure: true });
		expect(workerInputs.length).toBe(beforeTransfer);
		await writeFile(configPath, JSON.stringify(config));
		a.nextTurn();
		await aView.read("public.ts");
		const beforeInvalid = classifierInputs.length;
		await writeFile(configPath, "invalid");
		await expect(aView.read("public.ts")).rejects.toThrow("unavailable");
		await writeFile(configPath, JSON.stringify(config));
		await aView.read("public.ts");
		expect(classifierInputs.length).toBe(beforeInvalid + 1);
		expect(classifierInputs.join("\n")).not.toContain(
			"PRIVATE_SOURCE_SENTINEL",
		);
	} finally {
		permissions?.close();
		await snapshot?.dispose?.();
		await handlers.get("session_shutdown")?.({}, ctx);
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(repo.root, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	}
}, 30000);

test("PR search prompts only for matching skill content and keeps normal reads gated", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await mkdtemp(join(tmpdir(), "pr-search-permissions-"));
	const repo = await fixture();
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const events = {
		on(name: string, handler: (data: unknown) => void) {
			const set = listeners.get(name) ?? new Set();
			set.add(handler);
			listeners.set(name, set);
			return () => { set.delete(handler); };
		},
		emit(name: string, data: unknown) {
			for (const handler of listeners.get(name) ?? []) handler(data);
		},
	};
	const api = {
		events,
		on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler),
		registerCommand() {}, registerShortcut() {}, registerEntryRenderer() {}, appendEntry() {},
	};
	const skillPath = ".claude/skills/release/SKILL.md";
	const skills = [{ name: "release", filePath: join(repo.root, skillPath), baseDir: join(repo.root, ".claude/skills/release") }];
	const classifierInputs: string[] = [];
	let prompts = 0;
	const ctx = {
		cwd: repo.root, mode: "rpc", hasUI: true,
		getSystemPromptOptions: () => ({ skills }),
		sessionManager: { getSessionId: () => "search-test", getBranch: () => [], appendCustomEntry() {} },
		ui: {
			setStatus() {}, notify() {},
			select: async () => { prompts++; return "y approve once"; },
		},
		modelRegistry: {
			find: () => ({ provider: "fake", id: "classifier" }),
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, input: unknown) => {
				classifierInputs.push(JSON.stringify(input));
				return { content: [{ type: "toolCall", name: "submit_verdict", arguments: { verdict: "require_human", reason: "Confirm skill disclosure" } }] };
			},
		},
	};
	let snapshot: Awaited<ReturnType<typeof capture>> | undefined;
	let permissions: ReturnType<typeof openReviewPermissions> | undefined;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await put(repo.root, skillPath, "RELEASE_MATCH_SENTINEL\n");
		await put(repo.root, "blocked.ts", "RELEASE_MATCH_SENTINEL\n");
		await put(repo.root, ".env", "RELEASE_MATCH_SENTINEL\n");
		await commit(repo.root);
		await put(repo.root, "change.ts", "ordinary change\n");
		const configPath = join(agentDir, "extensions/pi-permission-system/config.json");
		const config = {
			permission: { "*": "allow", path: { "*": "allow", "blocked.ts": "deny" }, skill: "ask" },
			auto: { provider: "fake", model: "classifier", enabledByDefault: true, timeoutMs: 1000 },
		};
		await mkdir(join(agentDir, "extensions/pi-permission-system"), { recursive: true });
		await writeFile(configPath, JSON.stringify(config));
		permissionSystem(api as never);
		await handlers.get("session_start")?.({}, ctx);
		permissions = openReviewPermissions(api as never, ctx as never, repo, "local", new AbortController().signal, { command: "/pr" });
		snapshot = await capture(repo, { kind: "local" }, testConfig, permissions.host("Capture"));
		const access = permissions.task({ id: "searcher", name: "Searcher", assignment: "Search callers", model: "fake/reviewer", tools: ["read", "search_source"], kind: "worker" });
		const view = snapshot.withPermissions!(access);
		const search = snapshotTools(view).find((tool) => tool.name === "search_source")!;
		const absentQueryResponse = await search.execute("no-matches", { query: "absent" }, new AbortController().signal);
		const emptyResult = JSON.parse((absentQueryResponse.content[0] as { text: string }).text);
		expect(emptyResult.matches).toEqual([]);
		expect(emptyResult.denied.map((entry: { file: string }) => entry.file)).toEqual([".env", "blocked.ts"]);
		expect(emptyResult.complete).toBe(false);
		expect(prompts).toBe(0);
		expect(classifierInputs).toEqual([]);
		expect(access.dependencies).toEqual([]);
		await access.beforeDispatch();
		expect(prompts).toBe(0);

		const matchingResponse = await search.execute("matches", { query: "RELEASE_MATCH_SENTINEL" }, new AbortController().signal);
		const matchingResult = JSON.parse((matchingResponse.content[0] as { text: string }).text);
		expect(matchingResult.matches).toEqual([{ file: skillPath, line: 1, text: "RELEASE_MATCH_SENTINEL" }]);
		expect(prompts).toBe(1);
		expect(classifierInputs).toHaveLength(1);
		expect(classifierInputs[0]).not.toContain("RELEASE_MATCH_SENTINEL");
		expect(access.dependencies.map((effect) => effect.path)).toEqual([join(repo.root, skillPath)]);
		await view.read(skillPath);
		expect(prompts).toBe(2);

		await writeFile(configPath, JSON.stringify({ ...config, permission: { "*": "allow", skill: "deny" } }));
		const revoked = await search.execute("revoked", { query: "RELEASE_MATCH_SENTINEL", glob: ".claude/**" }, new AbortController().signal);
		const revokedResult = JSON.parse((revoked.content[0] as { text: string }).text);
		expect(revokedResult.matches).toEqual([]);
		expect(revokedResult.denied.map((entry: { file: string }) => entry.file)).toEqual([skillPath]);
		expect(prompts).toBe(2);
		await expect(access.beforeDispatch()).rejects.toThrow("Denied by permission policy");
	} finally {
		permissions?.close();
		await snapshot?.dispose?.();
		await handlers.get("session_shutdown")?.({}, ctx);
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(repo.root, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	}
}, 30000);

test("a visible PR dashboard yields to the real permission controls before receiving input", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await mkdtemp(join(tmpdir(), "pr-permission-focus-"));
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const events = {
		on(name: string, callback: (value: unknown) => void) {
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
		on: (name: string, handler: (event: any, ctx: any) => unknown) =>
			handlers.set(name, handler),
		registerCommand() {},
		registerShortcut() {},
		registerEntryRenderer() {},
		appendEntry() {},
	};
	const h = uiHarness();
	const ctx = {
		cwd: "/fixture",
		mode: "tui",
		hasUI: true,
		ui: h.ui,
		sessionManager: {
			getSessionId: () => "focus-test",
			getBranch: () => [],
			appendCustomEntry() {},
		},
		modelRegistry: {},
	};
	const dashboard = createReviewDashboard(ctx as never, new TaskStore(), {
		cancel() {},
	});
	const tracker = trackPermissionPrompts(events, (active) =>
		dashboard.setPermissionPromptActive(active),
	);
	let finish = () => {};
	let work: Promise<void> | undefined;
	let permission: Promise<unknown> | undefined;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const configDir = join(agentDir, "extensions", "pi-permission-system");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			join(configDir, "config.json"),
			JSON.stringify({
				permission: { "*": "ask" },
				auto: { provider: "fake", model: "fixture", enabledByDefault: false },
			}),
		);
		permissionSystem(api as never);
		await handlers.get("session_start")?.({}, ctx);
		work = dashboard.work(
			"Reviewing",
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		await Bun.sleep(0);
		expect(h.state.active!.render(120).join("\n")).toContain("PR REVIEW");
		permission = Promise.resolve(
			handlers.get("tool_call")!(
				{
					toolName: "read",
					toolCallId: "main-read",
					input: { path: "/fixture/public.ts" },
				},
				ctx,
			),
		);
		await Bun.sleep(0);
		expect(tracker.active).toBe(true);
		expect(h.state.active!.render(120).join("\n")).toContain("Human decision");
		expect(h.state.active!.render(120).join("\n")).not.toContain("PR REVIEW");
		const controls = h.state.active;
		dashboard.show();
		expect(h.state.active).toBe(controls);
		controls!.handleInput!("y");
		expect(await permission).toEqual({});
		expect(tracker.active).toBe(false);
		expect(h.state.active).toBeUndefined();
		finish();
		await work;
	} finally {
		finish();
		dashboard.dispose();
		tracker.dispose();
		await handlers.get("session_shutdown")?.({}, ctx);
		await permission;
		await work;
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(agentDir, { recursive: true, force: true });
	}
}, 10000);
