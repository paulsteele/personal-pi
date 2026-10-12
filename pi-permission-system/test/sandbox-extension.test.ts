import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import sandboxExtension from "../src/index.ts";
import { isAuditedHostUiTool, isAuditedSandboxTool } from "../src/sandbox/gate.ts";

it("registers mandatory sandbox tools without auto commands or shortcuts", () => {
  const commands: string[] = [];
  const tools: string[] = [];
  const shortcuts: string[] = [];
  const events = { on: () => () => {}, emit: () => {} };
  const pi = {
    events,
    on: () => () => {},
    registerEntryRenderer: () => {},
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: (name: string) => commands.push(name),
    registerShortcut: (key: string) => shortcuts.push(key),
  };
  sandboxExtension(pi as never);
  expect(commands).toEqual(["sandbox"]);
  expect(shortcuts).toEqual([]);
  const mandatorySandboxToolNames = [
    "read",
    "write",
    "edit",
    "ls",
    "find",
    "grep",
    "bash",
    "request_sandbox_tool",
    "request_host_mount",
  ];
  expect(tools).toEqual(mandatorySandboxToolNames);
});

const questionnaireSource = {
  path: "/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question/index.ts",
  source: "npm:@juicesharp/rpiv-ask-user-question",
  scope: "user" as const,
  origin: "package" as const,
};

it.each([
  "npm:@juicesharp/rpiv-ask-user-question",
  "npm:@juicesharp/rpiv-ask-user-question@2.12.0",
])("recognizes the audited questionnaire package source %s", (source) => {
  const tool = {
    name: "ask_user_question",
    sourceInfo: { ...questionnaireSource, source },
  } as ToolInfo;
  expect(isAuditedHostUiTool(tool)).toBe(true);
  expect(isAuditedSandboxTool(tool)).toBe(true);
});

it.each([
  { name: "bash", sourceInfo: questionnaireSource },
  {
    name: "ask_user_question",
    sourceInfo: { ...questionnaireSource, source: "npm:unknown-questionnaire" },
  },
  { name: "ask_user_question", sourceInfo: { ...questionnaireSource, origin: "top-level" } },
  {
    name: "ask_user_question",
    sourceInfo: { ...questionnaireSource, path: "/unknown/rpiv-ask-user-question/index.ts" },
  },
  {
    name: "ask_user_question",
    sourceInfo: { ...questionnaireSource, source: "npm:@juicesharp/rpiv-ask-user-question-fake" },
  },
])(
  "does not grant host UI authority to a mismatched tool or owner: $name $sourceInfo.source",
  (tool) => {
    expect(isAuditedHostUiTool(tool as ToolInfo)).toBe(false);
    expect(isAuditedSandboxTool(tool as ToolInfo)).toBe(false);
  },
);

it("the registered tool-call handler permits the audited questionnaire before sandbox initialization", async () => {
  let toolCall: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  const tool = { name: "ask_user_question", sourceInfo: questionnaireSource } as ToolInfo;
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
    { toolName: "ask_user_question", input: { questions: [] }, toolCallId: "question" },
    { signal: new AbortController().signal },
  );
  expect(result).toEqual({});
});

it("audits tool installation requests by extension source rather than tool name alone", () => {
  expect(
    isAuditedSandboxTool({
      name: "request_sandbox_tool",
      sourceInfo: { path: "/installed/pi-permission-system/src/index.ts" },
    } as ToolInfo),
  ).toBe(true);
  expect(
    isAuditedSandboxTool({
      name: "request_sandbox_tool",
      sourceInfo: { path: "/unknown/plugin.ts" },
    } as ToolInfo),
  ).toBe(false);
});

it("rejects unknown host tools even when they claim read-only annotations", () => {
  expect(
    isAuditedSandboxTool({
      name: "host_reader",
      annotations: { readOnlyHint: true },
      sourceInfo: { path: "/unknown/plugin.ts" },
    } as never),
  ).toBe(false);
  expect(
    isAuditedSandboxTool({ name: "read", sourceInfo: { path: "/unknown/plugin.ts" } } as never),
  ).toBe(false);
  expect(
    isAuditedSandboxTool({
      name: "read",
      sourceInfo: { path: "/installed/pi-permission-system/src/index.ts" },
    } as never),
  ).toBe(true);
  expect(
    isAuditedSandboxTool({
      name: "pr_review",
      sourceInfo: { path: "/installed/pr-review/index.ts" },
    } as never),
  ).toBe(true);
});
