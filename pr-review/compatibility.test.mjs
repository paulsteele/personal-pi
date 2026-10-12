import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHostLoader, openBrowserIfActive } from "./host-loader.mjs";

test("cancelled viewer imports cannot launch a late browser", async () => {
	let stopped = false,
		opened = 0,
		release;
	const imported = new Promise((resolve) => {
		release = resolve;
	});
	const pending = openBrowserIfActive(
		() => imported,
		"http://localhost/fixture",
		() => stopped,
	);
	stopped = true;
	release({
		openBrowser: async () => {
			opened++;
		},
	});
	assert.equal(await pending, false);
	assert.equal(opened, 0);
	assert.equal(
		await openBrowserIfActive(
			() => {
				throw new Error("must not import");
			},
			"http://localhost/fixture",
			() => true,
		),
		false,
	);
});

const piEntry = realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const piPackageDir = dirname(dirname(piEntry));
const here = dirname(fileURLToPath(import.meta.url));

test("host loader resolves TypeBox subpaths and loads the extension entry point", async () => {
	const loader = createHostLoader(piPackageDir);
	const { Check } = await loader.import("typebox/value");
	assert.equal(typeof Check, "function");
	const module = await loader.import(join(here, "index.ts"));
	const commands = [],
		tools = [];
	module.default({
		events: { on: () => () => {}, emit() {} },
		on() {},
		registerCommand(name) {
			commands.push(name);
		},
		registerTool(tool) {
			tools.push(tool);
		},
	});
	assert.deepEqual(commands, ["pr"]);
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["pr_review", "pr_review_result"],
	);
	assert.equal(tools[1].exposure, "direct");
	assert.deepEqual(tools[1].annotations, {
		readOnlyHint: true,
		destructiveHint: false,
		openWorldHint: false,
	});
});

test("installed Pi loader loads the shared permission owner without starting a session", async () => {
	const loader = createHostLoader(piPackageDir);
	const module = await loader.import(join(here, "..", "pi-permission-system", "src", "index.ts"));
	const commands = [];
	module.default({
		events: { on: () => () => {}, emit() {} },
		on() {},
		registerShortcut() {},
		registerEntryRenderer() {},
		registerTool() {},
		registerCommand(name) {
			commands.push(name);
		},
	});
	assert.deepEqual(commands, ["sandbox"]);
});

test("installed Pi executes the gated PR worker using synthetic permission/provider ports", async () => {
	const loader = createHostLoader(piPackageDir);
	const { runWorker } = await loader.import(join(here, "worker.ts"));
	const { PermissionScope } = await loader.import(join(here, "permissions.ts"));
	const { createAssistantMessageEventStream } = await loader.import("@earendil-works/pi-ai");
	const { Type } = await loader.import("typebox");
	const model = {
		provider: "fake",
		id: "fixture",
		api: "openai-responses",
		reasoning: false,
		contextWindow: 16000,
		maxTokens: 1000,
	};
	let checked = 0,
		requests = 0;
	const permissions = new PermissionScope({
		revision: () => "fixture",
		nextTurn() {},
		endTurn() {},
		close() {},
		check: async () => {
			checked++;
			return { kind: "allowed", revision: "fixture" };
		},
	});
	const result = await runWorker({
		config: {
			schemaVersion: 2,
			provider: "fake",
			model: "fixture",
			thinking: "off",
			concurrency: 1,
			historyLimit: 20,
			requestTimeoutMs: 1000,
		},
		permissions,
		system: "Synthetic compatibility probe",
		input: {},
		schema: Type.Object({ complete: Type.Boolean() }),
		registry: {
			find: () => model,
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true }),
			getProvider: () => ({
				streamSimple: () => {
					requests++;
					const stream = createAssistantMessageEventStream();
					const message = {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						timestamp: 0,
						stopReason: "toolUse",
						content: [
							{ type: "toolCall", id: "submit", name: "submit_result", arguments: { complete: true } },
						],
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
					stream.push({ type: "done", reason: "toolUse", message });
					return stream;
				},
			}),
		},
	});
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(checked, 1);
	assert.equal(requests, 1);
});

test("installed Pi focus handling yields both PR status and setup phases to permission controls", async () => {
	const loader = createHostLoader(piPackageDir);
	const { InteractiveMode } = await loader.import("@earendil-works/pi-coding-agent");
	const tuiModule = await loader.import("@earendil-works/pi-tui");
	const { Container, matchesKey } = tuiModule;
	const { createReviewDashboard } = await loader.import(join(here, "dashboard.ts"));
	const { createWorkUI } = await loader.import(join(here, "work-ui.ts"));
	const { TaskStore } = await loader.import(join(here, "tasks.ts"));
	const { presentPermissionPrompt } = await loader.import(
		join(here, "..", "pi-permission-system", "src", "prompt", "component.ts"),
	);
	const { buildPermissionPromptPayload } = await loader.import(
		join(here, "..", "pi-permission-system", "src", "prompt", "payload.ts"),
	);
	const renderers = new Set([tuiModule.TuiAltScreen, tuiModule.TuiMainScreen, tuiModule.TUI].filter(Boolean));
	assert.ok(renderers.size, "Installed Pi must expose a renderer for the focus probe");
	for (const Renderer of renderers) {
		let sendInput = () => {};
		const terminal = {
			columns: 120,
			rows: 30,
			kittyProtocolActive: false,
			start(input) {
				sendInput = input;
			},
			stop() {},
			write() {},
			moveBy() {},
			hideCursor() {},
			showCursor() {},
			clearLine() {},
			clearFromCursor() {},
			clearScreen() {},
			setTitle() {},
			setProgress() {},
			async drainInput() {},
		};
		const renderer = new Renderer(terminal);
		const editor = {
			getText: () => "",
			setText() {},
			render: () => ["EDITOR"],
			invalidate() {},
			handleInput() {},
		};
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		renderer.addChild(editorContainer);
		renderer.setFocus(editor);
		const keybindings = {
			getKeys: () => ["escape"],
			matches: (data, action) =>
				(action === "tui.select.cancel" && matchesKey(data, "escape")) ||
				(action === "tui.select.confirm" && matchesKey(data, "enter")),
		};
		const bridge = { editor, editorContainer, ui: renderer, keybindings, disposeActiveSelector() {} };
		const theme = { fg: (_color, text) => text, bg: (_color, text) => text };
		const ctx = {
			mode: "tui",
			ui: {
				setStatus() {},
				setWidget() {},
				notify() {},
				custom: (factory, options) =>
					InteractiveMode.prototype.showExtensionCustom.call(
						bridge,
						(tui, _theme, keys, done) => factory(tui, theme, keys, done),
						options,
					),
			},
		};
		const dashboard = createReviewDashboard(ctx, new TaskStore(), { readonly: true, cancel() {} });
		const tick = () => new Promise((resolve) => setImmediate(resolve));
		const phaseController = new AbortController();
		const phaseUI = createWorkUI(ctx, phaseController.signal, () => phaseController.abort());
		let phaseWork;
		try {
			renderer.start();
			for (const deferred of [false, true]) {
				dashboard.setPermissionPromptActive(false);
				dashboard.show();
				if (!deferred) {
					await tick();
					assert.equal(renderer.hasOverlay(), true);
				}
				dashboard.setPermissionPromptActive(true);
				const pending = presentPermissionPrompt(
					ctx,
					"Permission",
					buildPermissionPromptPayload({
						surface: "read",
						value: "/fixture/a.ts",
						matchedPattern: "*",
					}),
					false,
				);
				await tick();
				assert.equal(renderer.hasOverlay(), false);
				assert.match(editorContainer.children[0].render(120).join("\n"), /Human decision/);
				dashboard.show(); // Explicit status requests cannot steal permission focus either.
				sendInput("y");
				assert.equal(await pending, "approve");
				dashboard.setPermissionPromptActive(false);
				await tick();
				assert.equal(renderer.hasOverlay(), false);
			}
			dashboard.show();
			await tick();
			assert.equal(renderer.hasOverlay(), true);
			sendInput("\u001b");
			assert.equal(renderer.hasOverlay(), false);
			for (const label of ["Discovery", "Profile generation"]) {
				let finish,
					launches = 0;
				phaseWork = phaseUI.run(label, () => {
					launches++;
					return new Promise((resolve) => {
						finish = resolve;
					});
				});
				await tick();
				assert.match(editorContainer.children[0].render(120).join("\n"), new RegExp(label));
				phaseUI.setPermissionPromptActive(true);
				const pending = presentPermissionPrompt(
					ctx,
					"Permission",
					buildPermissionPromptPayload({ surface: "read", value: "/fixture/a.ts", matchedPattern: "*" }),
					false,
					false,
					phaseController.signal,
				);
				await tick();
				assert.match(editorContainer.children[0].render(120).join("\n"), /Human decision/);
				sendInput("y");
				assert.equal(await pending, "approve");
				phaseUI.setPermissionPromptActive(false);
				await tick();
				assert.match(editorContainer.children[0].render(120).join("\n"), new RegExp(label));
				assert.equal(launches, 1);
				finish();
				await phaseWork;
				assert.equal(editorContainer.children[0], editor);
			}
		} finally {
			phaseController.abort();
			phaseUI.dispose();
			await phaseWork?.catch(() => {});
			dashboard.dispose();
			renderer.stop();
		}
	}
});

test("installed Pi Agent executes a structured submission without a model call", async () => {
	const loader = createHostLoader(piPackageDir);
	const { Agent } = await loader.import("@earendil-works/pi-agent-core");
	const { createAssistantMessageEventStream } = await loader.import("@earendil-works/pi-ai");
	const { Type } = await loader.import("typebox");
	let submissions = 0;
	let calls = 0;
	const agent = new Agent({
		initialState: {
			model: {
				id: "compatibility",
				provider: "fake",
				api: "openai-responses",
				reasoning: false,
				contextWindow: 8192,
				maxTokens: 1024,
			},
			systemPrompt: "Compatibility fixture; no real model calls.",
			tools: [
				{
					name: "submit_review",
					label: "Submit",
					description: "Submit fixture findings",
					parameters: Type.Object({ findings: Type.Array(Type.String()) }),
					execute: async (_id, params) => {
						assert.deepEqual(params, { findings: [] });
						submissions++;
						return { content: [{ type: "text", text: "submitted" }], details: params, terminate: true };
					},
				},
			],
		},
		streamFn: () => {
			calls++;
			const stream = createAssistantMessageEventStream();
			const response = {
				role: "assistant",
				api: "openai-responses",
				provider: "fake",
				model: "compatibility",
				timestamp: Date.now(),
				content: [{ type: "toolCall", id: "submit-1", name: "submit_review", arguments: { findings: [] } }],
				stopReason: "toolUse",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			stream.push({ type: "done", reason: "toolUse", message: response });
			return stream;
		},
	});
	await agent.prompt("Submit the empty fixture review.");
	assert.equal(submissions, 1);
	assert.equal(calls, 1, "terminating submission must not start another model turn");
	assert.deepEqual(
		agent.state.tools.map((tool) => tool.name),
		["submit_review"],
	);
});
