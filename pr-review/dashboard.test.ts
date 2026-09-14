import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DashboardComponent, createReviewDashboard } from "./dashboard.js";
import { TaskStore } from "./tasks.js";
import { uiHarness } from "./ui.test.helpers.js";
const keys = { getKeys: () => ["escape"], matches: (data: string, action: string) => data === action };
const theme = { fg: (_color: string, text: string) => text };
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
