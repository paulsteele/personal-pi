import { expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handleDryCommand } from "./dry-commands.js";
import { emptyDryStatus } from "./dry-types.js";

it("routes Settings-compatible recovery actions through the same command operations", async () => {
	const refresh = vi.fn(async () => {});
	const setEnabled = vi.fn(async () => {});
	const notify = vi.fn();
	const ctx = { mode: "tui", isIdle: () => true, ui: { notify } } as unknown as ExtensionContext;
	const ports = { manager: { status: emptyDryStatus(), refresh }, setEnabled };
	const signal = new AbortController().signal;
	await handleDryCommand("status", ctx, ports, signal);
	await handleDryCommand("refresh", ctx, ports, signal);
	await handleDryCommand("off", ctx, ports, signal);
	expect(notify).toHaveBeenCalledOnce();
	expect(refresh).toHaveBeenCalledExactlyOnceWith(signal);
	await expect(handleDryCommand("clear-cache", ctx, ports, signal)).rejects.toThrow("Usage:");
	expect(setEnabled).toHaveBeenCalledExactlyOnceWith(false, ctx, signal);
});
it("does not start a scan while the agent is busy", async () => {
	const refresh = vi.fn(async () => {});
	const ctx = { mode: "tui", isIdle: () => false } as unknown as ExtensionContext;
	const ports = {
		manager: { status: emptyDryStatus(), refresh },
		setEnabled: async () => {},
	};
	const signal = new AbortController().signal;
	await expect(handleDryCommand("refresh", ctx, ports, signal)).rejects.toThrow("Wait for the agent");
	expect(refresh).not.toHaveBeenCalled();
});
