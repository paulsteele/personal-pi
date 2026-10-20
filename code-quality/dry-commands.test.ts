import { expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handleDryCommand, dryStatusText } from "./dry-commands.js";
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
it("distinguishes detector time and eligible files from end-to-end readiness", () => {
	const status = {
		...emptyDryStatus(),
		files: 2777,
		analyzedFiles: 2497,
		baselinePhase: "index transfer/validation" as const,
		baselineDurationMs: 6200,
		baselineTimings: {
			captureMs: 4200,
			detectorMs: 800,
			exportPreparationMs: 400,
			transferValidationMs: 700,
		},
		indexBytes: 20700000,
		indexShards: 40,
	};
	const text = dryStatusText({ status });
	expect(text).toContain("Baseline phase: index transfer/validation");
	expect(text).toContain("2497 analyzed files; 2777 lexically indexed files");
	expect(text).toContain(
		"6.20s total; capture 4.20s, detector 0.80s, export preparation 0.40s, transfer/validation 0.70s",
	);
	expect(text).toContain("20700000 bytes in 40 shards");
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
