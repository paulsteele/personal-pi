import { expect, it, vi } from "vitest";
import { boundedMap } from "./runner.js";
import { awaitWithSignal } from "./abort.js";

it("cancels both queued permits and suspended recovery without launching queued work", async () => {
	const controller = new AbortController();
	const started: number[] = [];
	const pending = boundedMap([0, 1, 2], 1, controller.signal, async (item, _index, suspend) => {
		started.push(item);
		const wait = () => awaitWithSignal(new Promise<void>(() => {}), controller.signal);
		if (item === 0) {
			await suspend(wait);
		} else {
			await wait();
		}
		return item;
	});
	const rejected = expect(pending).rejects.toThrow("Fixture cancelled");
	await vi.waitFor(() => expect(started).toEqual([0, 1]));
	controller.abort(new Error("Fixture cancelled"));
	await rejected;
	expect(started).toEqual([0, 1]);
});

it("bounds parallelism and preserves input-order results", async () => {
	let active = 0,
		peak = 0;
	const result = await boundedMap([0, 1, 2, 3, 4], 2, new AbortController().signal, async (item) => {
		active++;
		peak = Math.max(active, peak);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active--;
		return item * 2;
	});
	expect(peak).toBe(2);
	expect(result).toEqual([0, 2, 4, 6, 8]);
});
