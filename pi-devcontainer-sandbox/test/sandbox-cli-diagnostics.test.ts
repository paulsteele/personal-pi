import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { runDevcontainerCli } from "../src/sandbox/devcontainer-cli.ts";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
afterEach(() => vi.resetAllMocks());

function cliProcess(stdout: string, stderr: string, code: number) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  spawn.mockImplementation(() => {
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(stdout));
      child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child;
  });
}

it("records both CLI channels without displaying its machine-readable stdout", async () => {
  cliProcess('{"outcome":"success"}', "Container started\n", 0);
  const progress = vi.fn();
  const diagnostic = vi.fn();
  expect(await runDevcontainerCli({ args: ["up"], cwd: "/workspace", progress, diagnostic })).toBe(
    '{"outcome":"success"}',
  );
  expect(progress.mock.calls).toEqual([["Container started\n"]]);
  expect(diagnostic.mock.calls).toEqual([
    ['devcontainer up stdout: {"outcome":"success"}'],
    ["devcontainer up stderr: Container started\n"],
  ]);
});

it("retains complete failed build output in diagnostics before returning the bounded error", async () => {
  const stderr = `${"compiler output\n".repeat(1000)}final build failure\n`;
  cliProcess("", stderr, 1);
  const diagnostic = vi.fn();
  await expect(
    runDevcontainerCli({ args: ["build"], cwd: "/workspace", diagnostic }),
  ).rejects.toThrow("final build failure");
  expect(diagnostic).toHaveBeenCalledWith(`devcontainer build stderr: ${stderr}`);
});
