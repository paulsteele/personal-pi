import { getEventListeners } from "node:events";
import { expect, it } from "vitest";
import { awaitWithSignal } from "./abort.js";

it("returns the operation value and removes the abort listener", async () => {
	const controller = new AbortController();
	const pending = awaitWithSignal(Promise.resolve("snapshot"), controller.signal);
	expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
	await expect(pending).resolves.toBe("snapshot");
	expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("propagates the operation error and removes the abort listener", async () => {
	const controller = new AbortController();
	const error = new Error("snapshot unavailable");
	await expect(awaitWithSignal(Promise.reject(error), controller.signal)).rejects.toBe(error);
	expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("rejects an already aborted signal with its exact reason", async () => {
	const controller = new AbortController();
	const reason = { operation: "review", cause: "session ended" };
	controller.abort(reason);
	await expect(awaitWithSignal(Promise.resolve("late"), controller.signal)).rejects.toBe(reason);
	expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("keeps the PR fallback message for a null abort reason", async () => {
	const controller = new AbortController();
	controller.abort(null);
	await expect(awaitWithSignal(Promise.resolve("late"), controller.signal)).rejects.toThrow(
		"PR operation cancelled",
	);
});

it.each(["before waiting", "during waiting"])(
	"handles a late rejection after cancellation %s",
	async (when) => {
		const controller = new AbortController();
		const reason = new Error("operator cancelled");
		let rejectOperation!: (error: Error) => void;
		const operation = new Promise<string>((_resolve, reject) => {
			rejectOperation = reject;
		});
		if (when === "before waiting") controller.abort(reason);
		const pending = awaitWithSignal(operation, controller.signal);
		if (when === "during waiting") controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		rejectOperation(new Error("late operation failure"));
		await new Promise((resolve) => setImmediate(resolve));
	},
);
