import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { registerQualityGate } from "../code-quality/index.ts";
import { saveConfig } from "../code-quality/config.ts";
import { canonicalPath } from "../code-quality/capture.ts";
import type { QualityUI } from "../code-quality/controller.ts";
import type { ReviewResult } from "../code-quality/reviewer.ts";
import { parseQualityActivity, parseQualityHeader, type QualityHeader } from "../pi-atelier/src/quality-activity.ts";
import { createRunActivityTracker } from "../pi-atelier/src/run-activity.ts";
import { QUALITY_CHECK_ENTRY } from "../code-quality/feedback.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const approved = (): ReviewResult => ({ kind: "verdict", value: { verdict: "approved", rationale: "Clear", findings: [], edits: [], proposed: {} }, metrics: { requests: 1, latencyMs: 1, usages: [] } });

async function fixture(review: (options: any) => Promise<ReviewResult>, calls: string[], denied = false, uiOverride: Partial<QualityUI> = {}, script?: (turn: number, context: Context) => unknown[]) {
  const root = canonicalPath(mkdtempSync(join(tmpdir(), "pi-quality-integration-"))); directories.push(root);
  const cwd = join(root, "repo"), agentDir = join(root, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
  const activity = createRunActivityTracker({ cwd });
  const qualityHeaders: QualityHeader[] = [];
  saveConfig(agentDir, { provider: "synthetic", model: "fixture" });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const ui: QualityUI = { arbitrate: async () => ({ choice: "original", note: "Fixture decision" }), coverage: async () => undefined, failure: async () => undefined, ...uiOverride };
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [
    (pi) => { if (denied) pi.on("tool_call", (event) => event.toolName === "write" ? { block: true, reason: "Synthetic permission denial" } : undefined); },
    (pi) => registerQualityGate(pi, { ui, review }, agentDir),
    (pi) => {
      pi.events.on("code-quality:activity", (raw) => {
        const event = parseQualityActivity(raw);
        if (event) activity.recordQuality(event.toolCallId, event);
      });
      pi.events.on("code-quality:status", (raw) => {
        const header = parseQualityHeader(raw);
        if (header) qualityHeaders.push(header);
      });
      pi.on("tool_execution_start", (event) => activity.startTool(event));
      pi.on("tool_execution_end", (event) => activity.finishTool(event));
    },
  ] });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false });
  modelRuntime.registerProvider("synthetic", { baseUrl: "http://localhost/unused", apiKey: "fixture", api: "openai-completions", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 2000 }] });
  const model = modelRuntime.getModel("synthetic", "fixture")!;
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model, resourceLoader, sessionManager: SessionManager.inMemory(cwd), settingsManager, thinkingLevel: "off" });
  const errors: string[] = [];
  const uiContext = { setStatus() {}, notify() {}, setWidget() {}, setWorkingMessage() {}, setWorkingVisible() {}, setWorkingIndicator() {} } as unknown as ExtensionUIContext;
  await session.bindExtensions({ mode: "tui", uiContext, onError: (error) => errors.push(error.error) });
  let turn = 0;
  session.agent.streamFunction = (_model, context) => {
    calls.push(`main:${++turn}`);
    expect(JSON.stringify(context)).toContain("Code clarity policy");
    expect(JSON.stringify(context)).not.toContain(QUALITY_CHECK_ENTRY);
    if (turn > 12) throw new Error("Unexpected continuation loop");
    const content = script ? script(turn, context) : turn === 1 ? [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "a.ts", content: "const count = 1;\n" } }] : [{ type: "text", text: "Done" }];
    if (turn === 2 && !denied && !script) expect(JSON.stringify(context)).toContain("Quality approved");
    const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason: content.some((part: any) => part.type === "toolCall") ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;
    const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); return stream;
  };
  return { session, cwd, errors, activity, qualityHeaders };
}

test("real Pi waits for the post-write verdict before the next primary request", async () => {
  const calls: string[] = []; let release!: (result: ReviewResult) => void;
  const h = await fixture(async () => { calls.push("review"); return new Promise((resolve) => { release = resolve; }); }, calls);
  try {
    const pending = h.session.prompt("Write a fixture file.");
    for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual(["main:1", "review"]);
    const checkingEntries = h.session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === QUALITY_CHECK_ENTRY);
    expect(checkingEntries).toHaveLength(1);
    expect(readFileSync(join(h.cwd, "a.ts"), "utf8")).toBe("const count = 1;\n");
    release(approved()); await pending;
    expect(calls).toEqual(["main:1", "review", "main:2"]);
    expect(h.errors).toEqual([]);
    expect(JSON.stringify(h.session.messages)).toContain("Code clarity policy");
    expect(h.activity.getSnapshot().recentTools[0]).toMatchObject({ id: "write-1", quality: { phase: "approved" } });
    expect(h.qualityHeaders.at(-1)).toMatchObject({ phase: "approved", modelId: "synthetic/fixture" });
    const feedback = h.session.sessionManager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === "code-quality:feedback");
    expect(feedback).toMatchObject({ details: { outcome: "approved" }, content: expect.stringContaining("Quality approved") });
  } finally { h.session.dispose(); }
}, 20000);

test("unresolved finalization waits for five review exchanges before human arbitration", async () => {
  const calls: string[] = [];
  const h = await fixture(async (options) => {
    calls.push("review"); const file = options.request.files[0];
    return { ...approved(), value: { verdict: "needs_work", rationale: "Use a domain name", findings: [{ file: file.path, line: 1, quote: "const count", rule: "names", rationale: "Use a domain name" }], edits: [{ file: file.path, oldText: "count", newText: "invoiceCount" }], proposed: { [file.path]: "const invoiceCount = 1;\n" } } };
  }, calls, false, { arbitrate: async () => { calls.push("human"); return { choice: "original", note: "Keep count" }; } }, (turn) => turn === 1 ? [{ type: "toolCall", id: "w", name: "write", arguments: { path: "a.ts", content: "const count = 1;\n" } }] : [{ type: "text", text: "Done without correcting" }]);
  try {
    await h.session.prompt("Write code.");
    expect(calls).toEqual([
      "main:1", "review", "main:2", "review", "main:3", "review", "main:4", "review",
      "main:5", "review", "main:6", "review", "human",
    ]);
    expect(h.errors).toEqual([]);
    expect(JSON.stringify(h.session.messages)).toContain("user approved");
    expect(h.activity.getSnapshot().recentTools[0]).toMatchObject({ id: "w", quality: { phase: "user_approved" } });
    expect(h.qualityHeaders.at(-1)?.phase).toBe("user_approved");
  } finally { h.session.dispose(); }
}, 20000);

function qualityCaseFromMainAgentFeedback(context: Context): { caseId: string; revision: string } {
  const messages = context.messages;
  for (const message of [...messages].reverse()) {
    const text = typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.map((part) => part.text ?? "").join("\n") : "";
    const match = /Quality case ([^;]+); revision ([^;]+);/.exec(text);
    if (match) return { caseId: match[1]!, revision: match[2]! };
  }
  throw new Error("Expected current quality case in the main-agent feedback");
}

test("a real Pi disagreement returns to the reviewer and can resolve without an operator", async () => {
  const calls: string[] = [];
  const objection = "The name identifies the coordinate rather than a count.";
  const h = await fixture(async (options) => {
    calls.push("review");
    if (options.request.objection) {
      expect(options.request.objection).toBe(objection);
      return approved();
    }
    const file = options.request.files[0];
    return { ...approved(), value: { verdict: "needs_work", rationale: "Name the value", findings: [{ file: file.path, line: 1, quote: "const x", rule: "names", rationale: "Name the value" }], edits: [{ file: file.path, oldText: "x", newText: "count" }], proposed: { [file.path]: "const count = 1;\n" } } };
  }, calls, false, { arbitrate: async () => { throw new Error("Unexpected early operator arbitration"); } }, (turn, context) => {
    if (turn === 1) return [{ type: "toolCall", id: "write-coordinate", name: "write", arguments: { path: "a.ts", content: "const x = 1;\n" } }];
    if (turn === 2) return [{ type: "toolCall", id: "disagreement", name: "quality_response", arguments: { action: "disagree", ...qualityCaseFromMainAgentFeedback(context), rationale: objection } }];
    return [{ type: "text", text: "Done" }];
  });
  try {
    await h.session.prompt("Write code.");
    expect(calls).toEqual(["main:1", "review", "main:2", "review", "main:3"]);
    expect(h.errors).toEqual([]);
    expect(readFileSync(join(h.cwd, "a.ts"), "utf8")).toBe("const x = 1;\n");
    expect(h.qualityHeaders.at(-1)?.phase).toBe("approved");
  } finally { h.session.dispose(); }
}, 20000);

test("five unsuccessful real Pi disagreements reach the operator only after the fifth verdict", async () => {
  const calls: string[] = [];
  const h = await fixture(async (options) => {
    calls.push("review");
    const file = options.request.files[0];
    return { ...approved(), value: { verdict: "needs_work", rationale: "Name the value", findings: [{ file: file.path, line: 1, quote: "const x", rule: "names", rationale: "Name the value" }], edits: [{ file: file.path, oldText: "x", newText: "count" }], proposed: { [file.path]: "const count = 1;\n" } } };
  }, calls, false, { arbitrate: async (_ctx, state) => { calls.push("human"); expect(state.attempts).toBe(5); return { choice: "original", note: "Keep coordinate name" }; } }, (turn, context) => {
    if (turn === 1) return [{ type: "toolCall", id: "write-coordinate", name: "write", arguments: { path: "a.ts", content: "const x = 1;\n" } }];
    if (turn <= 6) return [{ type: "toolCall", id: `disagreement-${turn}`, name: "quality_response", arguments: { action: "disagree", ...qualityCaseFromMainAgentFeedback(context), rationale: "This is a coordinate name." } }];
    return [{ type: "text", text: "Done" }];
  });
  try {
    await h.session.prompt("Write code.");
    expect(calls).toEqual([
      "main:1", "review", "main:2", "review", "main:3", "review", "main:4", "review",
      "main:5", "review", "main:6", "review", "human", "main:7",
    ]);
    expect(h.errors).toEqual([]);
    expect(h.qualityHeaders.at(-1)?.phase).toBe("user_approved");
  } finally { h.session.dispose(); }
}, 20000);

test("permission-denied writes never enter quality capture or call the reviewer", async () => {
  const calls: string[] = [];
  const h = await fixture(async () => { calls.push("review"); return approved(); }, calls, true);
  try { await h.session.prompt("Write a fixture file."); expect(calls).toEqual(["main:1", "main:2"]); expect(h.errors).toEqual([]); }
  finally { h.session.dispose(); }
}, 20000);
