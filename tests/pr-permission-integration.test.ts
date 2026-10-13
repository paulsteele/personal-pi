import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import permissionSystem from "../pi-permission-system/src/permission-system.ts";
import { createReviewDashboard, trackPermissionPrompts } from "../pr-review/dashboard.ts";
import { TaskStore } from "../pr-review/tasks.ts";
import { uiHarness } from "../pr-review/ui.test.helpers.ts";

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
			for (const callback of listeners.get(name) ?? []) {
				callback(value);
			}
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
		if (previous === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previous;
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}, 10000);
