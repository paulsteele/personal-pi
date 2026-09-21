import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkUI } from "./work-ui.js";
import { uiHarness } from "./ui.test.helpers.js";

afterEach(() => vi.useRealTimers());
it("mounts before starting work, renders live activity and elapsed time, then releases the editor", async () => {
	vi.useFakeTimers();
	const h = uiHarness();
	const controller = new AbortController();
	const work = createWorkUI({ ui: h.ui } as ExtensionContext, controller.signal, () => controller.abort());
	let finish!: (value: string) => void;
	const pending = work.run("Discovering repository", () => {
		expect(h.state.active).toBeDefined();
		work.update("read: AGENTS.md");
		return new Promise<string>((resolve) => {
			finish = resolve;
		});
	});
	await vi.advanceTimersByTimeAsync(1000);
	expect(
		h.state.frames.some(
			(frame) => frame.includes("Discovering repository · 1s") && frame.includes("read: AGENTS.md"),
		),
	).toBe(true);
	finish("done");
	expect(await pending).toBe("done");
	expect(h.state.active).toBeUndefined();
	expect(vi.getTimerCount()).toBe(0);
	await expect(h.ui.select("Approval", ["Approve", "Cancel"])).resolves.toBe("Approve");
});
it("yields and restores phase presentation without restarting its task", async () => {
	vi.useFakeTimers();
	const h = uiHarness(),
		controller = new AbortController();
	const work = createWorkUI({ ui: h.ui } as ExtensionContext, controller.signal, () => controller.abort());
	let finish!: () => void;
	const task = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const pending = work.run("Discovery", task);
	await vi.advanceTimersByTimeAsync(0);
	work.setPermissionPromptActive(true);
	expect(h.state.active).toBeUndefined();
	const permission = h.ui.custom<string>((_tui, _theme, _keys, done) => ({
		render: () => ["PERMISSION"],
		invalidate() {},
		handleInput: done,
	}));
	await vi.advanceTimersByTimeAsync(0);
	work.update("Progress while paused");
	h.state.active!.handleInput!("approved");
	expect(await permission).toBe("approved");
	work.setPermissionPromptActive(false);
	await vi.advanceTimersByTimeAsync(0);
	expect(h.state.active!.render(120).join("\n")).toContain("Progress while paused");
	expect(task).toHaveBeenCalledOnce();
	finish();
	await pending;
	expect(h.state.active).toBeUndefined();
	expect(vi.getTimerCount()).toBe(0);
});

it("does not restore a phase after cancellation while its permission UI is active", async () => {
	vi.useFakeTimers();
	const h = uiHarness(),
		controller = new AbortController();
	const work = createWorkUI({ ui: h.ui } as ExtensionContext, controller.signal, () => controller.abort());
	const pending = expect(work.run("Profile", () => new Promise(() => {}))).rejects.toThrow();
	await vi.advanceTimersByTimeAsync(0);
	work.setPermissionPromptActive(true);
	const before = h.state.factories;
	controller.abort();
	await pending;
	work.setPermissionPromptActive(false);
	await vi.runAllTimersAsync();
	expect(h.state.factories).toBe(before);
	expect(h.state.active).toBeUndefined();
	expect(vi.getTimerCount()).toBe(0);
});

it("settles fast failures without leaking a spinner or swallowing the error", async () => {
	vi.useFakeTimers();
	const h = uiHarness();
	const controller = new AbortController();
	const work = createWorkUI({ ui: h.ui } as ExtensionContext, controller.signal, () => controller.abort());
	const rejected = expect(
		work.run("Preflight", () => {
			throw new Error("Missing profile");
		}),
	).rejects.toThrow("Missing profile");
	await vi.runAllTimersAsync();
	await rejected;
	expect(h.state.closes).toBe(1);
	expect(h.state.active).toBeUndefined();
	expect(vi.getTimerCount()).toBe(0);
});
it("cancels promptly using injected keybindings and ignores a late task result", async () => {
	vi.useFakeTimers();
	const h = uiHarness();
	const controller = new AbortController();
	const work = createWorkUI({ ui: h.ui } as ExtensionContext, controller.signal, () => controller.abort());
	let finish!: () => void;
	const pending = expect(
		work.run(
			"Waiting for worker",
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		),
	).rejects.toThrow();
	await vi.advanceTimersByTimeAsync(0);
	h.state.active!.handleInput?.("cancel-key");
	await pending;
	expect(h.state.active).toBeUndefined();
	expect(vi.getTimerCount()).toBe(0);
	finish();
	await Promise.resolve();
	await Promise.resolve();
	expect(h.state.closes).toBe(1);
});
it("cancels before launch without starting work or retaining timers", async () => {
	vi.useFakeTimers();
	const h = uiHarness();
	const controller = new AbortController();
	const task = vi.fn(async () => "late");
	const work = createWorkUI({ ui: h.ui } as ExtensionContext, controller.signal, () => controller.abort());
	const pending = expect(work.run("Preflight", task)).rejects.toThrow();
	controller.abort();
	await pending;
	await vi.runAllTimersAsync();
	expect(task).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});
