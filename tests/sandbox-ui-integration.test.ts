import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isAuditedHostUiTool } from "../pi-devcontainer-sandbox/src/sandbox/gate.ts";

const fixtureQuestionnaire = `import { Type } from "typebox";
export default function(pi) {
  pi.registerTool({
    name: "ask_user_question", label: "Ask User Question", description: "Fixture questionnaire",
    parameters: Type.Object({ question: Type.String() }),
    async execute(_id, input, _signal, _update, ctx) {
      const answer = await ctx.ui.select(input.question, ["Continue", "Cancel"]);
      return { content: [{ type: "text", text: answer ?? "Cancelled" }], details: undefined };
    },
  });
}
`;

test("real Pi recognizes package-owned questionnaire UI and permits it without a configured sandbox", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sandbox-ui-loader-")));
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");
  const packageRoot = join(agentDir, "npm/node_modules/@juicesharp/rpiv-ask-user-question");
  await mkdir(cwd);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "@juicesharp/rpiv-ask-user-question", version: "2.12.0", type: "module", pi: { extensions: ["./index.ts"] },
  }));
  await writeFile(join(packageRoot, "index.ts"), fixtureQuestionnaire);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({
      defaultProjectTrust: "always", packages: ["npm:@juicesharp/rpiv-ask-user-question"],
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [join(import.meta.dir, "../pi-devcontainer-sandbox/src/index.ts")],
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false,
    });
    created = await createAgentSession({ cwd, agentDir, resourceLoader, modelRuntime, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
    const tool = created.session.getAllTools().find((candidate) => candidate.name === "ask_user_question")!;
    expect(tool.sourceInfo.source).toBe("npm:@juicesharp/rpiv-ask-user-question");
    expect(tool.sourceInfo.path).toBe(join(packageRoot, "index.ts"));
    expect(isAuditedHostUiTool(tool)).toBe(true);
    const questions: string[] = [];
    await created.session.bindExtensions({
      mode: "rpc",
      uiContext: {
        notify() {}, setStatus() {},
        async select(question: string) { questions.push(question); return "Continue"; },
      } as unknown as ExtensionUIContext,
      onError: (error) => { throw new Error(error.error); },
    });
    created.session.agent.state.messages = [{
      role: "assistant", provider: "synthetic", api: "openai-completions", model: "fixture", timestamp: Date.now(),
      content: [{ type: "toolCall", id: "ui-fixture", name: "ask_user_question", arguments: { question: "Choose an approach?" } }],
      stopReason: "toolUse", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } as AssistantMessage];
    const ctx = created.session.extensionRunner.createToolContext("ui-fixture", undefined);
    const result = await ctx.executeTool("ask_user_question", { question: "Choose an approach?" });
    expect(result.result.content).toEqual([{ type: "text", text: "Continue" }]);
    expect(result.isError).not.toBe(true);
    expect(questions).toEqual(["Choose an approach?"]);
    const blockedRead = await ctx.executeTool("read", { path: "package.json" });
    expect(blockedRead.isError).toBe(true);
    expect(JSON.stringify(blockedRead.result.content)).toContain("No devcontainer definition");
  } finally {
    if (created) {
      await created.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      created.session.dispose();
    }
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
