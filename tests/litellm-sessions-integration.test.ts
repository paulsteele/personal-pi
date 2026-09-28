import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { observe } from "../progress-observer/observer.ts";
import { DEFAULT_CONFIG as observerConfig } from "../progress-observer/config.ts";
import { classify } from "../pi-permission-system/src/auto/classifier.ts";
import { DEFAULT_CONFIG as permissionConfig } from "../pi-permission-system/src/config.ts";
import { review } from "../code-quality/reviewer.ts";
import { DEFAULT_CONFIG as qualityConfig } from "../code-quality/config.ts";
import { runWorker, testConfig } from "../pr-review/test-fixtures.ts";
import { ReviewSubmission } from "../pr-review/types.ts";

type WireApi = "openai-completions" | "openai-responses";
type Flow = "activity" | "auto" | "quality" | "pr";
interface RequestBody {
  model: string;
  tools?: Array<{ name?: string; function?: { name: string } }>;
  [key: string]: unknown;
}
interface CapturedRequest {
  path: string;
  headers: Headers;
  body: RequestBody;
}
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const submissions: Record<string, unknown> = {
  submit_progress: { goal: "Ship tracking", progress: "Requests captured", current: "Checking groups" },
  submit_verdict: { verdict: "allow" },
  submit_quality_verdict: { verdict: "approved", rationale: "Clear", findings: [], edits: [] },
  submit_result: { complete: true, limitations: [], findings: [] },
  auxiliary_checks: {},
};
function completionResponse(api: WireApi, toolName?: string): Response {
  const args = JSON.stringify(toolName ? submissions[toolName] : {});
  let events: unknown[];
  if (api === "openai-completions") {
    events = [{
      id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: "fixture",
      choices: [{ index: 0, delta: toolName
        ? { role: "assistant", tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: { name: toolName, arguments: args } }] }
        : { role: "assistant", content: "Done" }, finish_reason: toolName ? "tool_calls" : "stop" }],
    }];
  } else {
    const item = toolName
      ? { id: "fc_fixture", type: "function_call", call_id: "call-fixture", name: toolName, arguments: args, status: "completed" }
      : { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done", annotations: [] }] };
    events = [
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
  }
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function fixture(api: WireApi, provider = "litellm", existingTraceHeaders = false) {
  const requests: CapturedRequest[] = [];
  let mainCalls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as RequestBody;
      requests.push({ path: new URL(request.url).pathname, headers: new Headers(request.headers), body });
      const names = body.tools?.map((tool) => tool.name ?? tool.function?.name) ?? [];
      const toolName = names.includes("auxiliary_checks")
        ? (++mainCalls === 1 ? "auxiliary_checks" : undefined)
        : names.find((name) => name && Object.hasOwn(submissions, name));
      return completionResponse(api, toolName);
    },
  });
  const directory = mkdtempSync(join(tmpdir(), "pi-flow-sessions-"));
  directories.push(directory);
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models-store.json"), refreshOnCreate: false,
  });
  runtime.registerProvider(provider, {
    baseUrl: `${server.url.origin}/v1`, apiKey: "synthetic-key", api,
    headers: { "x-auth-fixture": "preserved", ...(existingTraceHeaders ? { "X-LiteLLM-Trace-ID": "auth-parent" } : {}) },
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 2000,
      headers: { "x-model-fixture": "preserved", ...(existingTraceHeaders ? { "X-LITELLM-TRACE-ID": "model-parent" } : {}) },
    }],
  });
  const registry = new ModelRegistry(runtime);
  const model = registry.find(provider, "fixture")!;
  if (existingTraceHeaders) model.headers = { "X-LITELLM-TRACE-ID": "model-parent", "x-inline-fixture": "preserved" };
  async function call(flow: Flow, piSessionId?: string) {
    switch (flow) {
      case "activity":
        return observe({ caller: registry, model, piSessionId, prompt: "Report current work", config: observerConfig });
      case "auto":
        return classify({ caller: registry, model, piSessionId, config: permissionConfig.auto,
          context: { cwd: "/fixture", gitRemotes: [], recentUserTurns: ["Run tests"] },
          facts: { surface: "bash", toolName: "bash", invokedToolName: null, value: "bun test", matchedPattern: null, commandContext: null, executedUnit: null, agentName: null, evidence: [] },
        });
      case "quality":
        return review({ registry, piSessionId, config: { ...qualityConfig, provider, model: model.id },
          request: { files: [{ path: "a.ts", before: "", after: "const count = 1;", changedRanges: [[1, 1]], visibleRanges: [[1, 1]] }], input: "const count = 1;", notes: [] },
        });
      case "pr":
        return runWorker({ registry, piSessionId, sessionId: "worker-cache-session", config: { ...testConfig, provider, model: model.id }, schema: ReviewSubmission, system: "Review fixture", input: {} });
    }
  }
  return { requests, runtime, model, call, directory, close: () => server.stop(true) };
}

for (const api of ["openai-completions", "openai-responses"] as const) {
  test(`${api}: all four flows override mixed-case trace headers without changing bodies or cache IDs`, async () => {
    const h = await fixture(api, "litellm", true);
    try {
      const owner = "saved /雪";
      for (const flow of ["activity", "auto", "quality", "pr"] as const) {
        await h.call(flow);
        const baseline = h.requests.at(-1)!;
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await h.call(flow, owner);
          const expectedOutcome = { activity: "success", auto: "allow", quality: "verdict", pr: true }[flow];
          const actualOutcome = "ok" in result ? result.ok : result.kind;
          expect(actualOutcome).toBe(expectedOutcome);
          const captured = h.requests.at(-1)!;
          expect(captured.headers.get("x-litellm-trace-id")).toBe(`pi-saved%20%2F%E9%9B%AA-${flow}`);
          expect(captured.headers.get("authorization")).toBe("Bearer synthetic-key");
          expect(captured.headers.get("x-auth-fixture")).toBe("preserved");
          expect(captured.headers.get("x-model-fixture")).toBe("preserved");
          expect(captured.body).toEqual(baseline.body);
          expect(captured.path).toBe(api === "openai-completions" ? "/v1/chat/completions" : "/v1/responses");
        }
      }
      expect(h.model.headers?.["X-LITELLM-TRACE-ID"]).toBe("model-parent");
      const traces = new Set(h.requests.map((request) => request.headers.get("x-litellm-trace-id")).filter((trace) => trace?.startsWith("pi-")));
      expect(traces.size).toBe(4);
      expect(traces.has(owner)).toBe(false);
    } finally { h.close(); }
  }, 20000);
}

test.each(["openai", "litellm-alias"])("%s receives no auxiliary tracking", async (provider) => {
  const h = await fixture("openai-completions", provider);
  try {
    for (const flow of ["activity", "auto", "quality", "pr"] as const) await h.call(flow, "parent");
    expect(h.requests).toHaveLength(4);
    expect(h.requests.map((request) => request.headers.get("x-litellm-trace-id"))).toEqual([null, null, null, null]);
  } finally { h.close(); }
});

test("standalone quality calls have no inferred Pi session", async () => {
  const h = await fixture("openai-completions");
  try {
    const result = await h.call("quality");
    expect(result).toMatchObject({ kind: "verdict" });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.headers.get("x-litellm-trace-id")).toBeNull();
  } finally { h.close(); }
});

test("real Pi main requests keep their payload session while nested flows get independent traces", async () => {
  const h = await fixture("openai-completions");
  const sessionManager = SessionManager.inMemory(h.directory, { id: "main-owner" });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: h.directory, agentDir: h.directory, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [(pi) => {
      pi.on("before_provider_request", (event) => ({ ...event.payload as object, litellm_session_id: sessionManager.getSessionId() }));
      pi.registerTool({ name: "auxiliary_checks", label: "Auxiliary checks", description: "Run fixture auxiliary calls", parameters: Type.Object({}),
        async execute() {
          for (const flow of ["activity", "auto", "quality", "pr"] as const) await h.call(flow, sessionManager.getSessionId());
          return { content: [{ type: "text", text: "Quality approved; auxiliary checks complete." }], details: undefined };
        },
      });
    }],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: h.directory, agentDir: h.directory, modelRuntime: h.runtime, model: h.model, sessionManager, settingsManager, resourceLoader, tools: ["auxiliary_checks"], thinkingLevel: "off" });
  try {
    await session.bindExtensions({ mode: "print" });
    session.setActiveToolsByName(["auxiliary_checks"]);
    expect(session.getActiveToolNames()).toEqual(["auxiliary_checks"]);
    await session.prompt("Run auxiliary_checks once, then finish.");
    const mainRequests = h.requests.filter((request) => request.body.litellm_session_id === "main-owner");
    expect(mainRequests).toHaveLength(2);
    expect(mainRequests.map((request) => request.headers.get("x-litellm-trace-id"))).toEqual([null, null]);
    const nestedRequests = h.requests.filter((request) => request.body.litellm_session_id === undefined);
    expect(nestedRequests.map((request) => request.headers.get("x-litellm-trace-id"))).toEqual([
      "pi-main-owner-activity", "pi-main-owner-auto", "pi-main-owner-quality", "pi-main-owner-pr",
    ]);
  } finally { session.dispose(); h.close(); }
}, 20000);
