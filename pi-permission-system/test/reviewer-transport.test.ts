import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewerFilesystemTransport } from "../src/sandbox/reviewer-transport.ts";

const ports = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: ports.spawn,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

function transportFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      child.emit("close", null);
      return true;
    }),
  });
  ports.spawn.mockReturnValue(child);
  const controller = new AbortController();
  const transport = new ReviewerFilesystemTransport({
    args: ["exec", "-i", "reviewer", "python3"],
    env: {},
    signal: controller.signal,
  });
  return { child, transport, controller };
}

it("reuses one process and correlates fragmented responses for concurrent filesystem requests", async () => {
  const fixture = transportFixture();
  const first = fixture.transport.canonicalPaths(["/workspace/a.ts"]);
  const second = fixture.transport.canonicalPaths(["/workspace/b.ts"]);
  fixture.child.stdout.write('{"id":2,"result":["/workspace/b.ts"]}\n{"id":1,');
  fixture.child.stdout.write('"result":["/workspace/a.ts"]}\n');
  expect(await first).toEqual(["/workspace/a.ts"]);
  expect(await second).toEqual(["/workspace/b.ts"]);
  expect(ports.spawn).toHaveBeenCalledOnce();
  await fixture.transport.close();
});

it("rejects every pending request on malformed or unknown response identities", async () => {
  const fixture = transportFixture();
  const first = expect(fixture.transport.canonicalPaths(["a.ts"])).rejects.toThrow(
    "invalid response identity",
  );
  const second = expect(fixture.transport.canonicalPaths(["b.ts"])).rejects.toThrow(
    "invalid response identity",
  );
  fixture.child.stdout.write('{"id":99,"result":[]}\n');
  await first;
  await second;
  expect(fixture.child.kill).toHaveBeenCalledOnce();
  await fixture.transport.close();
});

it("fails a request timeout without another Podman exec and closes all pending requests", async () => {
  vi.useFakeTimers();
  const fixture = transportFixture();
  const pending = expect(fixture.transport.canonicalPaths(["a.ts"])).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(10_000);
  await pending;
  await fixture.transport.close();
  expect(ports.spawn).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a pending request and rejects subsequent use of the retired transport", async () => {
  const fixture = transportFixture();
  const cancellation = new AbortController();
  const pending = expect(
    fixture.transport.canonicalPaths(["a.ts"], cancellation.signal),
  ).rejects.toThrow("cancelled");
  cancellation.abort();
  await pending;
  await expect(fixture.transport.canonicalPaths(["b.ts"])).rejects.toThrow("cancelled");
  await fixture.transport.close();
});

it("retains startup stderr when the container's exec process exits", async () => {
  const fixture = transportFixture();
  const pending = expect(fixture.transport.request("ready")).rejects.toThrow("conmon failed");
  fixture.child.stderr.write("conmon failed");
  fixture.child.emit("close", 125);
  await pending;
  await fixture.transport.close();
});
