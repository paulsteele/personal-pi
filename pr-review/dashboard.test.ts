import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DashboardComponent, createReviewDashboard, trackPermissionPrompts } from "./dashboard.js";
import { TaskStore, type TaskState } from "./tasks.js";
import { uiHarness } from "./ui.test.helpers.js";
const keys = { getKeys: () => ["escape"], matches: (data: string, action: string) => data === action };
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
};
const ansiTheme = {
	fg: (color: string, text: string) => {
		const colors: Record<string, number> = {
			accent: 35,
			borderAccent: 36,
			text: 37,
			muted: 90,
			success: 32,
			warning: 33,
			error: 31,
		};
		return `\x1b[${colors[color]}m${text}\x1b[39m`;
	},
	bg: (color: string, text: string) => `\x1b[${color === "selectedBg" ? 45 : 44}m${text}\x1b[49m`,
};
function componentFor(tasks: TaskStore, height: () => number = () => 24, colors = theme) {
	return new DashboardComponent(
		tasks,
		colors,
		keys,
		height,
		() => {},
		() => {},
		() => {},
		() => {},
	);
}
function paintedCells(line: string) {
	const cells: Array<{ text: string; bg: number | undefined }> = [];
	let bg: number | undefined;
	for (const match of line.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)/g)) {
		if (match[1] !== undefined) {
			for (const code of match[1].split(";").map(Number)) {
				if (code === 0 || code === 49) bg = undefined;
				if (code === 44 || code === 45) bg = code;
			}
		} else cells.push({ text: match[2]!, bg });
	}
	return cells;
}
afterEach(() => vi.useRealTimers());
function store() {
	const tasks = new TaskStore();
	for (let i = 0; i < 40; i++)
		tasks.add({
			id: `task${i}`,
			stage: "review",
			name: `Reviewer ${i} λ`,
			files: [`source/${"long".repeat(50)}/${i}.ts`],
			reason: "Whole-change contracts",
		});
	return tasks;
}
it("keeps every task reachable, stable selection and bounded Unicode rendering", () => {
	const tasks = store(),
		hide = vi.fn(),
		cancel = vi.fn();
	const component = new DashboardComponent(
		tasks,
		theme,
		keys,
		() => 18,
		() => {},
		hide,
		cancel,
		() => {},
	);
	for (let i = 0; i < 39; i++) component.handleInput("tui.select.down");
	expect(component.render(80).join("\n")).toContain("Task 40/40");
	tasks.update("task0", { state: "completed" });
	expect(component.render(80).join("\n")).toContain("Task 40/40");
	component.handleInput("tui.select.confirm");
	for (const width of [1, 20, 80])
		for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	component.handleInput("tui.select.cancel");
	expect(hide).toHaveBeenCalledOnce();
	expect(cancel).not.toHaveBeenCalled();
	component.handleInput("c");
	component.handleInput("y");
	expect(cancel).toHaveBeenCalledOnce();
});
it("frames the summary, queue, selected-task preview and controls with padded, filled rows", () => {
	const tasks = new TaskStore();
	for (const [id, state, name] of [
		["capture", "completed", "Capture source"],
		["architecture", "running", "Architecture / Integration"],
		["packaging", "queued", "Packaging and host compatibility"],
		["security", "blocked", "Security"],
	] as const) {
		tasks.add({ id, stage: "review", name, files: ["source.ts"], reason: "Whole-change contracts" });
		tasks.update(id, { state });
	}
	tasks.setPhase("Reviewing changes · 4 concurrent workers");
	const component = componentFor(tasks);
	component.handleInput("tui.select.down");
	const lines = component.render(100),
		text = lines.join("\n");
	expect(lines[0]).toMatch(/^╭─ PR REVIEW ─+╮$/);
	expect(lines.at(-1)).toMatch(/^╰─+╯$/);
	expect(lines.filter((line) => line.startsWith("├"))).toHaveLength(3);
	for (const line of lines.slice(1, -1)) expect(line).toMatch(/^[│├].*[│┤]$/);
	for (const line of lines) expect(visibleWidth(line)).toBe(100);
	expect(text).toContain("1 running · 1 queued · 1 done · 1 blocked");
	expect(text).toContain("✓ completed");
	expect(text).toContain("▸● running");
	expect(text).toContain("○ queued");
	expect(text).toContain("! blocked");
	expect(text).toContain("Selected: Architecture / Integration");
	expect(text).toContain("escape hide");
	expect(text).toContain("r retry · c cancel");
	const taskRows = lines.filter((line) => /files\s+—/.test(line));
	expect(taskRows).toHaveLength(4);
	expect(new Set(taskRows.map((line) => line.indexOf("1 files"))).size).toBe(1);
});
it("keeps the background and selected-row padding painted through ANSI truncation resets", () => {
	const tasks = store();
	tasks.update("task0", { name: "界面 é 👩‍💻 ".repeat(25), state: "running" });
	const component = componentFor(tasks, () => 22, ansiTheme);
	for (const width of [6, 20, 60, 80, 120]) {
		const lines = component.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(width);
			expect(paintedCells(line).every((cell) => cell.bg !== undefined)).toBe(true);
		}
		const selected = lines.find((line) => paintedCells(line).some((cell) => cell.bg === 45))!;
		const cells = paintedCells(selected);
		expect(cells[0]).toEqual({ text: "│", bg: 44 });
		expect(cells.at(-1)).toEqual({ text: "│", bg: 44 });
		expect(cells.slice(1, -1).every((cell) => cell.bg === 45)).toBe(true);
		expect(
			cells
				.slice(1, -1)
				.map((cell) => cell.text)
				.join("")
				.endsWith(" "),
		).toBe(true);
	}
});
it("bounds both dimensions in empty, queue, detail and confirmation views, including tiny terminals", () => {
	let height = 1;
	for (const tasks of [new TaskStore(), store()]) {
		tasks.setProgress("Multiline progress\n" + "界 é 👩‍💻 ".repeat(100));
		const component = componentFor(tasks, () => height, ansiTheme);
		for (const view of ["queue", "detail", "confirm"]) {
			if (view === "detail") component.handleInput("tui.select.confirm");
			if (view === "confirm") component.handleInput("c");
			for (height = 1; height <= 25; height++)
				for (const width of [0, 1, 2, 4, 5, 6, 10, 20, 40, 80, 120]) {
					const lines = component.render(width);
					expect(lines.length).toBeLessThanOrEqual(height);
					for (const line of lines) {
						expect(visibleWidth(line)).toBe(width);
						expect(paintedCells(line).every((cell) => cell.bg !== undefined)).toBe(true);
					}
					if (width >= 6 && height >= 5) {
						expect(
							paintedCells(lines[0]!)
								.map((cell) => cell.text)
								.join(""),
						).toMatch(/^╭.*╮$/);
						expect(
							paintedCells(lines.at(-1)!)
								.map((cell) => cell.text)
								.join(""),
						).toMatch(/^╰.*╯$/);
					}
				}
		}
	}
});
it("uses the visible queue capacity for paging and preserves selection after resizing", () => {
	let height = 22;
	const component = componentFor(store(), () => height);
	const pageSize = component.render(100).filter((line) => /[▸ ]○ queued/.test(line)).length;
	expect(pageSize).toBeGreaterThan(1);
	component.handleInput("tui.select.pageDown");
	expect(component.render(100).join("\n")).toContain(`Task ${pageSize + 1}/40`);
	height = 12;
	expect(component.render(60).join("\n")).toContain(`Task ${pageSize + 1}/40`);
	expect(component.render(60).some((line) => line.includes(`▸○ queued     Reviewer ${pageSize} λ`))).toBe(
		true,
	);
	const smallPageSize = component.render(60).filter((line) => /[▸ ]○ queued/.test(line)).length;
	component.handleInput("tui.select.pageUp");
	expect(component.render(60).join("\n")).toContain(`Task ${Math.max(1, pageSize + 1 - smallPageSize)}/40`);
});
it("scrolls to the final detail line without losing the frame, footer or selected task", () => {
	const tasks = store();
	tasks.update("task0", {}, "Final activity marker");
	tasks.setProgress("Full progress marker " + "wrapped progress ".repeat(30));
	const component = componentFor(tasks, () => 18);
	component.handleInput("tui.select.confirm");
	component.render(70);
	for (let i = 0; i < 50; i++) {
		component.handleInput("tui.select.pageDown");
		component.render(70);
	}
	const lines = component.render(70);
	expect(lines.join("\n")).toContain("Final activity marker");
	expect(lines.join("\n")).toContain("Enter queue");
	expect(lines.at(-1)).toMatch(/^╰─+╯$/);
	component.handleInput("tui.select.confirm");
	expect(component.render(70).join("\n")).toContain("Task 1/40");
});
it("renders distinct icons and theme colors for every task state, with warning-colored cancellation", () => {
	const tasks = new TaskStore();
	const states: TaskState[] = [
		"queued",
		"running",
		"compacting",
		"retrying",
		"blocked",
		"completed",
		"cancelled",
		"failed",
		"skipped",
	];
	for (const state of states) {
		tasks.add({ id: state, stage: "review", name: `${state} reviewer`, files: [], reason: "Scope" });
		tasks.update(state, { state });
	}
	const component = componentFor(tasks, () => 30, ansiTheme);
	const text = component.render(120).join("\n");
	for (const [code, symbol, state] of [
		[90, "○", "queued"],
		[35, "●", "running"],
		[35, "↻", "compacting"],
		[33, "↻", "retrying"],
		[33, "!", "blocked"],
		[32, "✓", "completed"],
		[90, "×", "cancelled"],
		[31, "×", "failed"],
		[90, "–", "skipped"],
	])
		expect(text).toContain(`\x1b[${code}m${state === "queued" ? "▸" : " "}${symbol} ${state}`);
	component.handleInput("c");
	expect(component.render(120).join("\n")).toContain("\x1b[33mCancel the whole review? y confirms");
	component.handleInput("n");
	expect(component.render(120).join("\n")).toContain("escape hide");
});
it("redacts task content and flattens control whitespace before drawing the frame", () => {
	const tasks = store();
	tasks.update("task0", { name: "Name\n\r\t\x1b[31mspoof", reason: "Bearer abcdefghijklmnop" });
	const text = componentFor(tasks).render(100).join("\n");
	expect(text).toContain("Name   spoof");
	expect(text).not.toContain("\x1b[31m");
	expect(text).not.toContain("abcdefghijklmnop");
	expect(text).toContain("[redacted]");
});
it("mounts a centered 120-column panel with matching height and margin budgets", async () => {
	vi.useFakeTimers();
	const h = uiHarness(),
		custom = vi.spyOn(h.ui, "custom");
	const dashboard = createReviewDashboard({ mode: "tui", ui: h.ui } as ExtensionContext, store(), {
		cancel: () => {},
		readonly: true,
	});
	dashboard.show();
	await vi.advanceTimersByTimeAsync(0);
	expect(custom.mock.calls[0]?.[1]?.overlayOptions).toMatchObject({
		anchor: "center",
		width: 120,
		maxHeight: "100%",
		margin: 1,
	});
	const lines = h.state.active!.render(120);
	expect(lines).toHaveLength(22);
	expect(lines.at(-1)).toMatch(/^╰─+╯$/);
	dashboard.dispose();
	expect(vi.getTimerCount()).toBe(0);
});
it("minimizes for a permission prompt and cannot reopen or auto-restore over it", async () => {
	vi.useFakeTimers();
	const h = uiHarness();
	const dashboard = createReviewDashboard({ mode: "tui", ui: h.ui } as ExtensionContext, store(), {
		cancel: vi.fn(),
	});
	let finish!: () => void;
	const work = dashboard.work(
		"Reviewing",
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	await vi.advanceTimersByTimeAsync(0);
	const oldDashboard = h.state.active!;
	dashboard.setPermissionPromptActive(true);
	expect(h.state.active).toBeUndefined();
	let answer: string | undefined;
	const permission = h.ui.custom<string>((_tui, _theme, _keys, done) => ({
		render: () => ["Permission: y approve, n deny"],
		invalidate() {},
		handleInput: (key) => {
			answer = key;
			done(key);
		},
	}));
	await vi.advanceTimersByTimeAsync(0);
	const permissionPanel = h.state.active;
	dashboard.show();
	expect(h.state.active).toBe(permissionPanel);
	expect(h.state.notifications.at(-1)?.message).toContain("Finish the permission prompt");
	expect(oldDashboard.render(120)).toEqual([]);
	oldDashboard.handleInput?.("cancel-key");
	expect(answer).toBeUndefined();
	h.state.active!.handleInput!("y");
	expect(await permission).toBe("y");
	dashboard.setPermissionPromptActive(false);
	expect(h.state.active).toBeUndefined();
	finish();
	await work;
	const next = dashboard.work(
		"Next stage",
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	await vi.advanceTimersByTimeAsync(0);
	expect(h.state.active).toBeUndefined();
	dashboard.show();
	await vi.advanceTimersByTimeAsync(0);
	expect(h.state.active!.render(120).join("\n")).toContain("PR REVIEW");
	finish();
	await next;
	dashboard.dispose();
	expect(vi.getTimerCount()).toBe(0);
});

it("does not steal permission focus if the dashboard mounts after the prompt starts", async () => {
	vi.useFakeTimers();
	const h = uiHarness();
	const dashboard = createReviewDashboard({ mode: "tui", ui: h.ui } as ExtensionContext, store(), {
		cancel() {},
		readonly: true,
	});
	dashboard.show(); // Its custom component has not mounted yet.
	dashboard.setPermissionPromptActive(true);
	const permission = h.ui.custom<string>((_tui, _theme, _keys, done) => ({
		render: () => ["PERMISSION"],
		invalidate() {},
		handleInput: (key) => done(key),
	}));
	await vi.advanceTimersByTimeAsync(0);
	expect(h.state.active!.render(80)).toEqual(["PERMISSION"]);
	expect(h.state.closes).toBe(1); // Only the stale dashboard closed.
	h.state.active!.handleInput!("approve");
	expect(await permission).toBe("approve");
	dashboard.dispose();
	expect(h.state.closes).toBe(h.state.factories);
	expect(vi.getTimerCount()).toBe(0);
});

it("tracks all actual permission prompts until their matching terminal decisions and unsubscribes", () => {
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
	const changed = vi.fn();
	const tracker = trackPermissionPrompts(events, changed);
	events.emit("permissions:ui_prompt", { requestId: "main" });
	events.emit("permissions:ui_prompt", { requestId: "child", delegated: { taskId: "reviewer" } });
	events.emit("permissions:decision", { requestId: "unrelated" });
	events.emit("permissions:decision", { requestId: "main" });
	expect(tracker.active).toBe(true);
	expect(changed.mock.calls).toEqual([[true]]);
	events.emit("permissions:decision", { requestId: "child" });
	expect(tracker.active).toBe(false);
	expect(changed.mock.calls).toEqual([[true], [false]]);
	tracker.dispose();
	events.emit("permissions:ui_prompt", { requestId: "retired" });
	expect(tracker.active).toBe(false);
	expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
});

it("coalesces actual host widget/status updates and avoids replacing unchanged summaries", async () => {
	vi.useFakeTimers();
	const tasks = store(),
		setWidget = vi.fn(),
		setStatus = vi.fn();
	const dashboard = createReviewDashboard(
		{ mode: "tui", ui: { setWidget, setStatus, notify: vi.fn() } } as unknown as ExtensionContext,
		tasks,
		{ cancel: () => {} },
	);
	for (let i = 0; i < 100; i++) tasks.update("task0", { turns: i }, "read finished");
	expect(setWidget).not.toHaveBeenCalled();
	expect(setStatus).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(100);
	expect(setWidget).toHaveBeenCalledOnce();
	expect(setStatus).toHaveBeenCalledOnce();
	for (let i = 0; i < 100; i++) tasks.update("task0", { turns: i }, "another read finished");
	await vi.advanceTimersByTimeAsync(100);
	expect(setWidget).toHaveBeenCalledOnce();
	expect(setStatus).toHaveBeenCalledOnce();
	dashboard.dispose();
	expect(vi.getTimerCount()).toBe(0);
});
it("retires a dashboard before deferred mounting without leaking an overlay", async () => {
	vi.useFakeTimers();
	const h = uiHarness();
	const dashboard = createReviewDashboard({ mode: "tui", ui: h.ui } as ExtensionContext, store(), {
		cancel: () => {},
	});
	const pending = dashboard.work("Fast preflight", async () => {});
	dashboard.dispose();
	await pending;
	await vi.advanceTimersByTimeAsync(0);
	expect(h.state.active).toBeUndefined();
	expect(h.state.closes).toBe(h.state.factories);
	expect(vi.getTimerCount()).toBe(0);
});
it("dismisses and reopens without restarting work; cleans all timers and releases native approvals", async () => {
	vi.useFakeTimers();
	const h = uiHarness(),
		tasks = store(),
		cancel = vi.fn();
	const dashboard = createReviewDashboard({ mode: "tui", ui: h.ui } as ExtensionContext, tasks, { cancel });
	let finish!: () => void;
	const task = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const pending = dashboard.work("Reviewing", task);
	await vi.advanceTimersByTimeAsync(0);
	expect(h.state.active).toBeDefined();
	h.state.active!.handleInput!("cancel-key");
	expect(cancel).not.toHaveBeenCalled();
	expect(h.state.active).toBeUndefined();
	dashboard.show();
	await vi.advanceTimersByTimeAsync(0);
	expect(h.state.active).toBeDefined();
	expect(task).toHaveBeenCalledOnce();
	finish();
	await pending;
	await expect(h.ui.select("Specialist approval", ["yes"])).resolves.toBe("yes");
	dashboard.dispose();
	expect(vi.getTimerCount()).toBe(0);
});
