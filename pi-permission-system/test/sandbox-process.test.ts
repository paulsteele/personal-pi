import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runGuestProcess } from "../src/sandbox/process.ts";
import { requestSandboxTool } from "../src/sandbox/tool-installation.ts";
import type { SandboxSession } from "../src/sandbox/session.ts";

const ports = vi.hoisted(() => ({ spawn: vi.fn(), podman: vi.fn(), plan: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: ports.spawn,
}));
vi.mock("../src/sandbox/driver.ts", () => ({ podmanOutput: ports.podman }));
vi.mock("../src/sandbox/image-tools.ts", () => ({ planImageTools: ports.plan }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

function stalledExecFixture() {
  vi.useFakeTimers();
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
  ports.podman.mockImplementation(async (_args: string[], signal?: AbortSignal) => {
    return new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const options = {
    container: "rebuilt-container",
    user: "root",
    cwd: "/workspace",
    command: ["sh", "-c", 'command -v "$1"', "sh", "bun"],
  };
  return { child, options };
}

it("bounds a stalled exec even when its guest-process termination command also stalls", async () => {
  const fixture = stalledExecFixture();
  const process = runGuestProcess({ ...fixture.options, timeoutMs: 10_000 });
  const completed = vi.fn();
  const outcome = process.catch((error) => {
    completed();
    return error;
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(ports.podman).toHaveBeenCalledTimes(1);
  expect(completed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(completed).toHaveBeenCalledTimes(1);
  expect(await outcome).toMatchObject({ message: "Guest process timed out" });
  expect(fixture.child.kill).toHaveBeenCalledWith("SIGKILL");
});

it("bounds cancellation while Podman is unresponsive and preserves the caller's abort reason", async () => {
  const fixture = stalledExecFixture();
  const cancellation = new AbortController();
  const process = runGuestProcess({ ...fixture.options, signal: cancellation.signal });
  const completed = vi.fn();
  const outcome = process.catch((error) => {
    completed();
    return error;
  });
  const reason = new Error("Operator cancelled installation");
  cancellation.abort(reason);
  expect(ports.podman).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(completed).toHaveBeenCalledTimes(1);
  expect(await outcome).toBe(reason);
  expect(fixture.child.kill).toHaveBeenCalledWith("SIGKILL");
});

it("finishes an approved installation with a probe timeout after the build completes", async () => {
  const fixture = stalledExecFixture();
  const apply = vi.fn(async () => {});
  ports.plan.mockResolvedValue({ preview: "Install Bun in the image", apply });
  const session = {
    options: { confirm: async () => true, resolved: {} },
    execute: (options: { command: string[]; signal: AbortSignal; timeoutMs: number }) =>
      runGuestProcess({ ...fixture.options, ...options }),
  } as unknown as SandboxSession;
  const report = vi.fn();
  const request = {
    tool: "bun",
    version: "1.3.10",
    command: ["npm", "install", "--global", "bun@1.3.10"],
    executable: "bun",
    prerequisites: ["npm"],
    reason: "Run the workspace tests",
  };
  const installation = requestSandboxTool(
    session,
    request,
    new AbortController().signal,
    "install-bun",
    report,
  );
  const completed = vi.fn();
  const outcome = installation.catch((error) => {
    completed();
    return error;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith("Devcontainer rebuild complete.");
  expect(report).toHaveBeenLastCalledWith("Checking runtime executable bun (10-second timeout)…");
  expect(completed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(completed).toHaveBeenCalledTimes(1);
  expect((await outcome).message).toContain("runtime executable probe for bun failed");
  expect((await outcome).cause.message).toBe("Guest process timed out");
  expect(apply).toHaveBeenCalledTimes(1);
});

it("terminates the guest process group before closing a responsive Podman exec", async () => {
  const fixture = stalledExecFixture();
  ports.podman.mockImplementationOnce(async () => {
    expect(fixture.child.kill).not.toHaveBeenCalled();
    return "";
  });
  const cancellation = new AbortController();
  const process = runGuestProcess({ ...fixture.options, signal: cancellation.signal });
  const outcome = process.catch((error) => error);
  cancellation.abort(new Error("Cancelled"));
  await expect(outcome).resolves.toMatchObject({ message: "Cancelled" });
  expect(fixture.child.kill).toHaveBeenCalledWith("SIGKILL");
  expect(vi.getTimerCount()).toBe(0);
});
