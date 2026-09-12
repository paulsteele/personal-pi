import { expect, it, vi } from "vitest";
import { BlobCache } from "./blob-cache.js";

it("deduplicates pending reads, reserves before allocating, and bounds aggregate residency", async () => {
	let active = 0,
		peak = 0;
	const load = vi.fn(async (id: string, size: number) => {
		active++;
		peak = Math.max(peak, active);
		expect(cache.stats.reservedBytes).toBe(size);
		expect(cache.stats.retainedBytes + cache.stats.reservedBytes).toBeLessThanOrEqual(12);
		await new Promise<void>((resolve) => setImmediate(resolve));
		active--;
		return Buffer.from(id.repeat(6));
	});
	const cache = new BlobCache({ maxBytes: 12, maxFileBytes: 8, size: async () => 6, load });
	const first = cache.get("a");
	expect(cache.get("a")).toBe(first);
	await Promise.all([first, ...["b", "c", "d", "e"].map((id) => cache.get(id))]);
	expect(peak).toBe(1);
	expect(cache.stats).toMatchObject({ retainedBytes: 12, reservedBytes: 0, entries: 2, pending: 0 });
	expect(load).toHaveBeenCalledTimes(5);
	await cache.get("e");
	expect(load).toHaveBeenCalledTimes(5);
	expect((await cache.get("a")).toString()).toBe("aaaaaa");
	expect(load).toHaveBeenCalledTimes(6);
	expect(cache.stats.retainedBytes).toBeLessThanOrEqual(12);
});
it("rejects oversized/mismatched blobs without poisoning later reads or reservations", async () => {
	const load = vi.fn(async (id: string) => Buffer.from(id === "bad" ? "wrong" : "ok"));
	const cache = new BlobCache({
		maxBytes: 4,
		maxFileBytes: 4,
		size: async (id) => (id === "huge" ? 10 : 2),
		load,
	});
	await expect(cache.get("huge")).rejects.toThrow("budget");
	expect(load).not.toHaveBeenCalled();
	await expect(cache.get("bad")).rejects.toThrow("size changed");
	expect(cache.stats.reservedBytes).toBe(0);
	expect((await cache.get("good")).toString()).toBe("ok");
});
