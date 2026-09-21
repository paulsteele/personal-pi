import { expect, it } from "vitest";
import { CoverageLedger } from "./tasks.js";
import { commitToolResult } from "./tool-commit.js";

it("discards only the denied tool's delivery and retains a concurrent successful read", async () => {
	const ledger = new CoverageLedger(["a", "b"]);
	let reject!: (error: Error) => void;
	const denied = commitToolResult(async () => {
		ledger.deliver("a", 0, 4, 4);
		await new Promise<void>((_resolve, fail) => {
			reject = fail;
		});
	}).catch(() => {});
	expect(ledger.remaining).toEqual(["a", "b"]);
	await commitToolResult(async () => {
		ledger.deliver("b", 0, 4, 4);
	});
	reject(new Error("Post-execution permission denied"));
	await denied;
	expect(ledger.remaining).toEqual(["a"]);
});

it("does not attach a future tool to a retired async transaction", async () => {
	const ledger = new CoverageLedger(["later"]);
	let finish!: () => void;
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	await commitToolResult(async () => {
		setImmediate(() => {
			void commitToolResult(async () => {
				ledger.deliver("later", 0, 1, 1);
			}).then(finish);
		});
	});
	await done;
	expect(ledger.remaining).toEqual([]);
});

it("does not persist checkpoint bookkeeping before the enclosing tool is accepted", async () => {
	const ledger = new CoverageLedger([]);
	await expect(
		commitToolResult(async () => {
			ledger.checkpoint({ key: "denied", notes: "must not be saved" });
			expect(ledger.notes).toEqual([]);
			throw new Error("denied");
		}),
	).rejects.toThrow("denied");
	expect(ledger.notes).toEqual([]);
	await commitToolResult(async () => {
		ledger.checkpoint({ key: "accepted", notes: "saved" });
	});
	expect(ledger.notes).toEqual([{ key: "accepted", notes: "saved" }]);
});
