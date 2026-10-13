import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configPath } from "../src/config.ts";
import sandboxExtension from "../src/index.ts";
import {
  isAuthorizedHostTool,
  isAuditedSandboxTool,
  reviewSandboxToolCall,
} from "../src/sandbox/gate.ts";
import { parseSandboxSettings, saveSandboxSettings } from "../src/sandbox/settings.ts";

const plannotatorSubmitPlanScenario = {
  name: "plannotator_submit_plan",
  source: "npm:@plannotator/pi-extension",
  path: "/agent/npm/node_modules/@plannotator/pi-extension/index.ts",
  input: { filePath: "plans/app.md" },
};

const hostToolScenarios = [
  {
    name: "web_search",
    source: "npm:pi-web-access",
    path: "/agent/npm/node_modules/pi-web-access/dist/index.js",
    input: { queries: ["Xcode simulator testing"], includeContent: true },
  },
  {
    name: "source_check",
    source: "npm:pi-web-access",
    path: "/agent/npm/node_modules/pi-web-access/dist/index.js",
    input: { claim: "Xcode requires macOS", fetchContent: true },
  },
  {
    name: "fetch_content",
    source: "npm:pi-web-access",
    path: "/agent/npm/node_modules/pi-web-access/dist/index.js",
    input: { url: "file:///host/private/demo.mp4", frames: 3, auth: "work" },
  },
  {
    name: "get_search_content",
    source: "npm:pi-web-access",
    path: "/agent/npm/node_modules/pi-web-access/dist/index.js",
    input: { responseId: "current-result", offset: 120 },
  },
  {
    name: "plannotator",
    source: "npm:@plannotator/pi-extension",
    path: "/agent/npm/node_modules/@plannotator/pi-extension/index.ts",
    input: { action: "annotate", target: "/host/plans/app.md" },
  },
  plannotatorSubmitPlanScenario,
  {
    name: "plannotator_mark_done",
    source: "npm:@plannotator/pi-extension",
    path: "/agent/npm/node_modules/@plannotator/pi-extension/index.ts",
    input: { step: 2 },
  },
].flatMap((scenario) => {
  if (scenario.source !== "npm:@plannotator/pi-extension") {
    return [scenario];
  }
  return [scenario, { ...scenario, path: dirname(scenario.path) }];
});
type HostToolScenario = (typeof hostToolScenarios)[number];

function hostTool(scenario: HostToolScenario, version?: string): ToolInfo {
  return {
    name: scenario.name,
    sourceInfo: {
      path: scenario.path,
      source: version ? `${scenario.source}@${version}` : scenario.source,
      scope: "user",
      origin: "package",
    },
  } as ToolInfo;
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
  directories.length = 0;
});

async function hostGateFixture(scenario: HostToolScenario) {
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "sandbox-host-tools-")));
  directories.push(agentDir);
  const tool = hostTool(scenario);
  const input = structuredClone(scenario.input);
  const getSession = vi.fn(() => {
    throw new Error("Mandatory sandbox is unavailable");
  });
  const review = (signal?: AbortSignal) =>
    reviewSandboxToolCall({
      tool,
      getSession,
      agentDir,
      input,
      ctx: { signal } as never,
    });
  return { agentDir, tool, input, getSession, review };
}

it.each(hostToolScenarios)("recognizes authorized package ownership for $name", (scenario) => {
  expect(isAuthorizedHostTool(hostTool(scenario))).toBe(true);
  expect(isAuditedSandboxTool(hostTool(scenario))).toBe(true);
  expect(isAuthorizedHostTool(hostTool(scenario, "1.2.3"))).toBe(true);
});

it("recognizes the pi-web-access TypeScript entry point as well as its published bundle", () => {
  const tool = hostTool(hostToolScenarios[0]!);
  tool.sourceInfo.path = "/agent/npm/node_modules/pi-web-access/index.ts";
  expect(isAuthorizedHostTool(tool)).toBe(true);
});

it.each(hostToolScenarios)(
  "rejects lookalikes and unapproved capabilities for $name",
  (scenario) => {
    const tool = hostTool(scenario);
    const lookalikes = [
      { ...tool, sourceInfo: { ...tool.sourceInfo, origin: "top-level" as const } },
      { ...tool, sourceInfo: { ...tool.sourceInfo, source: "npm:unknown-plugin" } },
      { ...tool, sourceInfo: { ...tool.sourceInfo, source: `${scenario.source}-lookalike` } },
      { ...tool, sourceInfo: { ...tool.sourceInfo, path: "/unknown/index.ts" } },
      { ...tool, name: "bash" },
      { ...tool, name: "unapproved_host_tool" },
      { ...tool, name: "mcp__web__fetch_content" },
    ];
    for (const lookalike of lookalikes) {
      expect(isAuthorizedHostTool(lookalike)).toBe(false);
      expect(isAuditedSandboxTool(lookalike)).toBe(false);
    }
  },
);

it.each([
  "/agent/npm/node_modules/@plannotator/pi-extension-lookalike",
  "/agent/npm/node_modules/@plannotator/pi-extension-lookalike/index.ts",
  "/agent/npm/node_modules/@plannotator/pi-extension/server.ts",
  "/agent/npm/node_modules/@plannotator/pi-extension/generated/index.ts",
  "/agent/npm/node_modules/@plannotator/pi-extension/dist/index.js",
])("rejects unapproved Plannotator entry %s", (path) => {
  const tool = hostTool(plannotatorSubmitPlanScenario);
  tool.sourceInfo.path = path;
  expect(isAuthorizedHostTool(tool)).toBe(false);
  expect(isAuditedSandboxTool(tool)).toBe(false);
});

it.each(hostToolScenarios)(
  "allows $name without a container, prompts, or input rewriting",
  async (scenario) => {
    const fixture = await hostGateFixture(scenario);
    await fixture.review();
    expect(fixture.getSession).not.toHaveBeenCalled();
    expect(fixture.input).toEqual(scenario.input);
  },
);

it.each(hostToolScenarios)("preserves an explicit deny for $name", async (scenario) => {
  const fixture = await hostGateFixture(scenario);
  await saveSandboxSettings(
    fixture.agentDir,
    parseSandboxSettings({ permission: { [scenario.name]: "deny" } }),
    undefined,
  );
  await expect(fixture.review()).rejects.toThrow("Tool denied by explicit policy");
  expect(fixture.getSession).not.toHaveBeenCalled();
});

it.each(hostToolScenarios)("blocks cancelled $name calls", async (scenario) => {
  const fixture = await hostGateFixture(scenario);
  await expect(fixture.review(AbortSignal.abort())).rejects.toThrow();
  expect(fixture.getSession).not.toHaveBeenCalled();
});

it.each(hostToolScenarios)("does not require sandbox migration for $name", async (scenario) => {
  const fixture = await hostGateFixture(scenario);
  await mkdir(dirname(configPath(fixture.agentDir)), { recursive: true });
  await writeFile(
    configPath(fixture.agentDir),
    JSON.stringify({
      permission: {},
      auto: { provider: "fixture", model: "fixture", enabledByDefault: false },
    }),
  );
  await fixture.review();
  expect(fixture.getSession).not.toHaveBeenCalled();
});

it.each(hostToolScenarios)(
  "the registered tool-call handler admits $name before container startup",
  async (scenario) => {
    let toolCall: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
    const tool = hostTool(scenario);
    const pi = {
      events: { on: () => () => {}, emit() {} },
      on(name: string, handler: typeof toolCall) {
        if (name === "tool_call") {
          toolCall = handler;
        }
      },
      getAllTools: () => [tool],
      registerEntryRenderer() {},
      registerTool() {},
      registerCommand() {},
    };
    sandboxExtension(pi as never);
    const result = await toolCall!(
      {
        toolName: scenario.name,
        input: structuredClone(scenario.input),
        toolCallId: "host-tool-1",
      },
      { signal: new AbortController().signal },
    );
    expect(result).toEqual({});
  },
);
