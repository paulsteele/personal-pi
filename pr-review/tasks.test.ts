import { expect, it } from "vitest";
import { normalizeConfig } from "./config.js";
import { testConfig } from "./test-fixtures.js";
import { CoverageLedger, RecoveryGate, TaskStore } from "./tasks.js";

it("normalizes legacy config without retaining work quotas or mutating it", () => {
	const before = JSON.stringify(testConfig);
	expect(normalizeConfig(testConfig)).toEqual({
		schemaVersion: 2,
		provider: "fake",
		model: "test",
		thinking: "off",
		concurrency: 4,
		requestTimeoutMs: 300000,
		historyLimit: 20,
	});
	expect(JSON.stringify(testConfig)).toBe(before);
});
it("requires contiguous full delivery and acknowledgment; checkpoints are idempotent", () => {
	const ledger = new CoverageLedger(["diff:a", "doc:rules"]);
	const point = { key: "one", reviewed: ["diff:a"], findings: [], notes: "Checked" };
	ledger.deliver("diff:a", 0, 5, 10);
	ledger.deliver("diff:a", 6, 10, 10);
	expect(() => ledger.checkpoint(point)).toThrow("all pages");
	ledger.deliver("diff:a", 5, 7, 10);
	expect(ledger.checkpoint(point)).toBe(true);
	expect(ledger.checkpoint(point)).toBe(false);
	expect(() => ledger.checkpoint({ ...point, notes: "changed" })).toThrow("reused");
	expect(() => ledger.assertComplete()).toThrow("doc:rules");
	ledger.deliver("doc:rules", 0, 0, 0);
	ledger.checkpoint({ key: "two", reviewed: ["doc:rules"], findings: [], notes: "Empty document checked" });
	expect(() => ledger.assertComplete()).not.toThrow();
});
it("pauses competing failures behind one retry gate and cancellation wakes waits", async () => {
	const store = new TaskStore(),
		controller = new AbortController();
	for (const id of ["a", "b"]) store.add({ id, name: id, stage: "review", files: [], reason: "test" });
	const gate = new RecoveryGate(store, controller.signal);
	const a = gate.block("a", "provider"),
		b = gate.block("b", "source");
	expect(gate.blockers.size).toBe(2);
	gate.retry();
	await Promise.all([a, b]);
	expect(store.records.get("a")!.retries).toBe(1);
	const pending = expect(gate.block("a", "again")).rejects.toThrow();
	controller.abort();
	await pending;
});
it("keeps all task records but only recent activity; cancellation rejects late updates", () => {
	const store = new TaskStore();
	store.add({ id: "one", name: "Security", stage: "review", files: ["a"], reason: "baseline" });
	for (let i = 0; i < 30; i++) store.update("one", { state: "running" }, `turn ${i}`);
	expect(store.events.get("one")).toHaveLength(20);
	store.cancel();
	store.update("one", { state: "completed" });
	expect(store.snapshot()[0]!.state).toBe("cancelled");
	expect(JSON.stringify(store.snapshot())).not.toContain("turn 0");
});
