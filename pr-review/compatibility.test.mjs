import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
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

const piPackageDir = process.env.PR_REVIEW_TEST_PI_PACKAGE;
const plannotatorDir = process.env.PR_REVIEW_TEST_PLANNOTATOR_PACKAGE;
const here = dirname(fileURLToPath(import.meta.url));
const configured = piPackageDir && plannotatorDir;
const patch = [
	"diff --git a/src/example.ts b/src/example.ts",
	"index 1234567..7654321 100644",
	"--- a/src/example.ts",
	"+++ b/src/example.ts",
	"@@ -1 +1 @@",
	"-export const enabled = false;",
	"+export const enabled = true;",
	"",
].join("\n");

test("host loader resolves TypeBox subpaths and loads the extension entry point", {
	skip: !configured,
}, async () => {
	const loader = createHostLoader(piPackageDir);
	const { Check } = await loader.import("typebox/value");
	assert.equal(typeof Check, "function");
	const module = await loader.import(join(here, "index.ts"));
	const commands = [],
		tools = [];
	module.default({
		on() {},
		registerCommand(name) {
			commands.push(name);
		},
		registerTool(tool) {
			tools.push(tool.name);
		},
	});
	assert.deepEqual(commands, ["pr"]);
	assert.deepEqual(tools, ["pr_review"]);
});

test("installed Pi loader loads the shared permission owner without starting a session", {
	skip: !piPackageDir,
}, async () => {
	const loader = createHostLoader(piPackageDir);
	const module = await loader.import(join(here, "..", "pi-permission-system", "src", "index.ts"));
	const commands = [];
	module.default({
		events: { on: () => () => {}, emit() {} },
		on() {},
		registerShortcut() {},
		registerEntryRenderer() {},
		registerCommand(name) {
			commands.push(name);
		},
	});
	assert.deepEqual(commands, ["auto", "auto-model"]);
});

test("installed Pi executes the gated PR worker using synthetic permission/provider ports", {
	skip: !piPackageDir,
}, async () => {
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

test("installed Pi focus handling yields both PR status and setup phases to permission controls", {
	skip: !piPackageDir,
}, async () => {
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

// Opt-in local probe: module paths are supplied explicitly, never inferred from private settings.
test("installed Pi Agent executes a structured submission without a model call", {
	skip: !configured,
}, async () => {
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

async function startViewer(t) {
	const dir = await mkdtemp(join(tmpdir(), "pi-pr-review-compat-"));
	await mkdir(join(dir, "data"));
	// A real file distinguishes captured source from accidental live-file fallback.
	await mkdir(join(dir, "src"));
	await writeFile(join(dir, "src", "example.ts"), "LIVE FILE MUST NOT REPLACE SNAPSHOT\n");
	const child = spawn(
		process.execPath,
		[join(here, "compatibility-viewer.mjs"), piPackageDir, plannotatorDir],
		{
			cwd: dir,
			env: {
				...process.env,
				PLANNOTATOR_AI: "disabled",
				PLANNOTATOR_SHARE: "disabled",
				PLANNOTATOR_REMOTE: "0",
				PLANNOTATOR_PORT: "",
				PLANNOTATOR_DATA_DIR: join(dir, "data"),
				PI_CODING_AGENT_DIR: join(dir, "agent"),
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (part) => {
		stderr += part.toString();
	});
	const events = [];
	const listeners = new Set();
	const lines = createInterface({ input: child.stdout });
	let exited = false;
	const closed = new Promise((resolve) =>
		child.once("close", (code, signal) => {
			exited = true;
			resolve({ code, signal });
			for (const listener of listeners) listener();
		}),
	);
	lines.on("line", (line) => {
		if (!line.startsWith("PR_REVIEW_COMPAT ")) return;
		events.push(JSON.parse(line.slice("PR_REVIEW_COMPAT ".length)));
		for (const listener of listeners) listener();
	});
	const wait = (type) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${type}: ${stderr}`)), 30_000);
			function finish(error, value) {
				clearTimeout(timer);
				listeners.delete(check);
				if (error) reject(error);
				else resolve(value);
			}
			function check() {
				const failure = events.find((event) => event.type === "error" || event.type === "unexpected-network");
				const event = events.find((event) => event.type === type);
				if (failure) finish(new Error(JSON.stringify(failure)));
				else if (event) finish(undefined, event);
				else if (exited) finish(new Error(`Viewer exited before ${type}: ${stderr}`));
			}
			listeners.add(check);
			check();
		});
	t.after(async () => {
		if (!exited) child.kill("SIGTERM");
		const killTimer = setTimeout(() => {
			if (!exited) child.kill("SIGKILL");
		}, 3000);
		await closed;
		clearTimeout(killTimer);
		lines.close();
		await rm(dir, { recursive: true, force: true });
	});
	child.stdin.write(
		`${JSON.stringify({
			type: "start",
			patch,
			annotations: [
				{
					source: "pr-review:compatibility",
					author: "Correctness",
					type: "concern",
					filePath: "src/example.ts",
					lineStart: 1,
					lineEnd: 1,
					side: "new",
					text: "[high] F1: Review the changed default",
					reasoning: "Captured quote: export const enabled = true;",
				},
			],
		})}\n`,
	);
	const ready = await wait("ready");
	assert.equal(ready.ids.length, 1);
	return { ...ready, wait, closed, events, dir };
}

test("installed Plannotator serves and submits captured annotations with AI disabled", {
	skip: !configured,
	timeout: 45_000,
}, async (t) => {
	const viewer = await startViewer(t);
	const diff = await (await fetch(`${viewer.url}/api/diff`)).json();
	assert.equal(diff.rawPatch, patch);
	assert.ok(!diff.gitContext, "snapshot mode must not expose a live Git context");
	const ai = await (await fetch(`${viewer.url}/api/ai/capabilities`)).json();
	assert.equal(ai.available, false);
	const annotations = await (await fetch(`${viewer.url}/api/external-annotations`)).json();
	assert.equal(annotations.annotations[0].id, viewer.ids[0]);
	assert.equal(annotations.annotations[0].source, "pr-review:compatibility");
	assert.equal(annotations.annotations[0].lineStart, 1);
	assert.equal(annotations.annotations[0].side, "new");
	for (const path of ["/api/file-content?path=src/example.ts", "/api/code-nav/file?path=src/example.ts"]) {
		const denied = await fetch(`${viewer.url}${path}`);
		assert.equal(denied.status, 400, `${path} must refuse live-file access`);
		assert.ok((await denied.json()).error);
	}
	for (const [path, body] of [
		["/api/git-add", { filePath: "src/example.ts" }],
		["/api/diff/switch", { diffType: "staged" }],
	]) {
		const denied = await fetch(`${viewer.url}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		assert.ok(denied.status >= 400, `${path} must refuse live Git operations`);
	}
	assert.equal((await (await fetch(`${viewer.url}/api/diff`)).json()).rawPatch, patch);
	const html = await fetch(viewer.url);
	assert.equal(html.status, 200);
	assert.match(html.headers.get("content-type"), /text\/html/);
	// API contract probe, not a fabricated human decision on a real review.
	const submission = {
		approved: false,
		feedback: "Synthetic fixture feedback",
		annotations: annotations.annotations,
	};
	const response = await fetch(`${viewer.url}/api/feedback`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(submission),
	});
	assert.equal(response.status, 200);
	const decision = await viewer.wait("decision");
	assert.equal(decision.result.approved, false);
	assert.equal(decision.result.annotations[0].id, viewer.ids[0]);
	assert.equal(decision.result.feedback, submission.feedback);
	assert.deepEqual(await viewer.closed, { code: 0, signal: null });
	assert.equal(
		await readFile(join(viewer.dir, "src", "example.ts"), "utf8"),
		"LIVE FILE MUST NOT REPLACE SNAPSHOT\n",
	);
	assert.ok(!viewer.events.some((event) => event.type === "unexpected-network"));
});
