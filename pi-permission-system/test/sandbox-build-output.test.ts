import { expect, it, vi } from "vitest";
import { StartupBuildOutput } from "../src/sandbox/build-output.ts";

it("summarizes cached layers and omits tag lists without hiding build steps or warnings", () => {
  const output = vi.fn();
  const build = new StartupBuildOutput(output);
  build.write("[2026-10-13T11:36:36.317Z] [1/2] STEP 1/2: FROM node:24\n");
  build.write("[2026-10-13T11:36:36.873Z] --> Using ca");
  build.write(`che ${"a".repeat(64)}\n--> ${"a".repeat(12)}\n`);
  build.write(
    `Successfully tagged localhost/pi-sandbox-first:latest\nSuccessfully tagged localhost/pi-sandbox-second:latest\n${"a".repeat(64)}\n`,
  );
  build.write("warning: deprecated package\nunfinished build message");
  build.finish();
  expect(output.mock.calls.map(([text]) => text)).toEqual([
    "[2026-10-13T11:36:36.317Z] [1/2] STEP 1/2: FROM node:24\n",
    "warning: deprecated package\n",
    "unfinished build message\n",
    "Reused 1 cached build steps.\n",
  ]);
});

it("keeps installer output and failures visible, including their terminal styles", () => {
  const output = vi.fn();
  const build = new StartupBuildOutput(output);
  build.write("Downloading runtime\r\n\x1b[31merror: install failed\x1b[0m\n");
  build.finish();
  expect(output.mock.calls.map(([text]) => text)).toEqual([
    "Downloading runtime\n",
    "\x1b[31merror: install failed\x1b[0m\n",
  ]);
});
