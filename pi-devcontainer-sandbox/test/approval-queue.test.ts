import { expect, it, vi } from "vitest";
import { ApprovalQueue } from "#src/approval-queue.ts";

it("serializes human work, removes cancelled queued requests and releases active cancellation", async () => {
  const queue = new ApprovalQueue();
  const active = new AbortController(),
    queued = new AbortController();
  const order: string[] = [];
  const first = queue.run(
    active.signal,
    (signal) =>
      new Promise<string>((resolve) => {
        order.push("first");
        signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
      }),
  );
  const never = vi.fn(async () => "should not run");
  const second = queue.run(queued.signal, never).catch(() => "queued cancelled");
  const third = queue.run(undefined, async () => {
    order.push("third");
    return "done";
  });
  await vi.waitFor(() => expect(order).toEqual(["first"]));
  queued.abort();
  expect(await second).toBe("queued cancelled");
  active.abort();
  expect(await first).toBe("cancelled");
  expect(await third).toBe("done");
  expect(never).not.toHaveBeenCalled();
  expect(order).toEqual(["first", "third"]);
  queue.dispose();
  await expect(queue.run(undefined, never)).rejects.toBeDefined();
});

it("does not strand later prompts after one throws", async () => {
  const queue = new ApprovalQueue();
  const first = queue
    .run(undefined, async () => {
      throw new Error("UI failed");
    })
    .catch(() => "failed");
  const second = queue.run(undefined, async () => "next");
  expect(await first).toBe("failed");
  expect(await second).toBe("next");
  queue.dispose();
});
