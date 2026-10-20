import { afterEach, expect, it, vi } from "vitest";
import { DryBaselineDeadline } from "./dry-baseline-deadline.js";

afterEach(() => vi.useRealTimers());
it("bounds the whole baseline rather than renewing the budget for each phase", async () => {
	vi.useFakeTimers();
	const deadline = new DryBaselineDeadline(100, new AbortController().signal);
	deadline.phase = "capture";
	await vi.advanceTimersByTimeAsync(60);
	deadline.phase = "index transfer/validation";
	const waiting = deadline.wait(new Promise<never>(() => {}));
	const rejection = expect(waiting).rejects.toThrow("timed out during index transfer/validation after 100ms");
	await vi.advanceTimersByTimeAsync(40);
	await rejection;
	deadline.close();
});
it("rejects promptly even if the underlying service ignores cancellation", async () => {
	const owner = new AbortController();
	const deadline = new DryBaselineDeadline(60000, owner.signal);
	const waiting = deadline.wait(new Promise<never>(() => {}));
	owner.abort(new Error("session retired"));
	await expect(waiting).rejects.toThrow("session retired");
	deadline.close();
});
it("does not turn a late response into successful readiness", async () => {
	const owner = new AbortController();
	const deadline = new DryBaselineDeadline(60000, owner.signal);
	let reply!: (value: string) => void;
	const operation = new Promise<string>((resolve) => {
		reply = resolve;
	});
	const waiting = deadline.wait(operation);
	owner.abort(new Error("cancelled request"));
	reply("ready");
	await expect(waiting).rejects.toThrow("cancelled request");
	deadline.close();
});
