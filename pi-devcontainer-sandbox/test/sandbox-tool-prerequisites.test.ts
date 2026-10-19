import { expect, it, vi } from "vitest";
import type { SandboxSession } from "../src/sandbox/session.ts";
import {
  findMissingPrerequisites,
  MissingPrerequisitesError,
  prerequisiteProviderIds,
} from "../src/sandbox/tool-prerequisites.ts";
import { requestSandboxTool } from "../src/sandbox/tool-installation.ts";
import type { ResolvedTool } from "../src/sandbox/tool-profile.ts";

const planner = vi.hoisted(() => vi.fn());
vi.mock("../src/sandbox/image-tools.ts", () => ({ planImageTools: planner }));

const nodeRecipe: ResolvedTool = {
  id: "node",
  source: "project",
  dependencies: [],
  entry: {
    kind: "recipe",
    version: "24.0.0",
    command: ["sh", "-c", "install node"],
    environment: {},
    executable: "/usr/local/bin/node",
    prerequisites: [],
    dependencies: [],
  },
};

const playwrightRequest = {
  tool: "playwright-chromium",
  version: "1.58.2",
  command: ["npx", "playwright", "install", "chromium"],
  executable: "/root/.cache/ms-playwright/chromium",
  prerequisites: ["node", "npx"],
  reason: "End-to-end tests need a headless browser.",
};

function sessionMissing(missingExecutables: string[], profileTools: ResolvedTool[] = []) {
  const confirm = vi.fn(async () => true);
  const execute = vi.fn(async () => ({
    code: 0,
    output: Buffer.from(missingExecutables.map((name) => `${name}\n`).join("")),
    stderr: "",
  }));
  const session = {
    options: {
      agentDir: "/agent",
      resolved: {
        path: "/agent/global/devcontainer.json",
        tier: "global",
        layers: undefined,
        project: { id: "a".repeat(64), kind: "projects", root: "/project" },
      },
      confirm,
    },
    execute,
  } as unknown as SandboxSession;
  if (profileTools.length) {
    (session.options.resolved as { layers?: unknown }).layers = { tools: profileTools };
  }
  return { session, confirm, execute };
}

it("probes every prerequisite in one guest command and returns those not on PATH", async () => {
  const fixture = sessionMissing(["npx"]);
  const signal = new AbortController().signal;
  expect(await findMissingPrerequisites(fixture.session, ["node", "npx"], signal)).toEqual(["npx"]);
  expect(fixture.execute).toHaveBeenCalledExactlyOnceWith({
    command: [
      "sh",
      "-c",
      'for name; do command -v "$name" >/dev/null 2>&1 || echo "$name"; done',
      "sh",
      "node",
      "npx",
    ],
    signal,
    timeoutMs: 10_000,
  });
});

it("refuses an installation whose prerequisites are missing before asking for approval", async () => {
  const fixture = sessionMissing(["node", "npx"]);
  const installation = requestSandboxTool(
    fixture.session,
    playwrightRequest,
    new AbortController().signal,
    "install-playwright",
  );
  await expect(installation).rejects.toBeInstanceOf(MissingPrerequisitesError);
  await expect(installation).rejects.toThrow(
    "playwright-chromium needs node, npx, which the sandbox image does not provide. Request node and npx with request_sandbox_tool first",
  );
  expect(fixture.confirm).not.toHaveBeenCalled();
  expect(planner).not.toHaveBeenCalled();
});

it("matches a profile tool that provides a prerequisite by id or executable name", () => {
  expect(prerequisiteProviderIds(["node", "npx"], [nodeRecipe])).toEqual(["node"]);
  const renamedNode = { ...nodeRecipe, id: "nodejs" };
  expect(prerequisiteProviderIds(["node"], [renamedNode])).toEqual(["nodejs"]);
  expect(prerequisiteProviderIds(["bun"], [nodeRecipe])).toEqual([]);
});

it("accepts a prerequisite that another profile tool will provide", async () => {
  const fixture = sessionMissing(["node"], [nodeRecipe]);
  planner.mockResolvedValue(undefined);
  fixture.execute
    .mockResolvedValueOnce({ code: 0, output: Buffer.from("node\n"), stderr: "" })
    .mockResolvedValueOnce({
      code: 0,
      output: Buffer.from("/root/.cache/ms-playwright/chromium\n"),
      stderr: "",
    });
  const nodeOnlyRequest = { ...playwrightRequest, prerequisites: ["node"] };
  const result = await requestSandboxTool(
    fixture.session,
    nodeOnlyRequest,
    new AbortController().signal,
    "install-playwright",
  );
  expect(planner).toHaveBeenCalledOnce();
  expect(result.executable).toBe("/root/.cache/ms-playwright/chromium");
});
