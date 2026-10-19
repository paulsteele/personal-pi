import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isAuthorizedHostTool } from "../pi-devcontainer-sandbox/src/sandbox/gate.ts";

const fixturePlanSubmission = `import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
export default function(pi) {
  pi.registerTool({
    name: "plannotator_submit_plan", label: "Submit Plan", description: "Fixture plan submission",
    parameters: Type.Object({ filePath: Type.String() }),
    async execute(_id, input, _signal, _update, ctx) {
      const plan = readFileSync(resolve(ctx.cwd, input.filePath), "utf8");
      ctx.ui.notify("Fixture plan received", "info");
      return { content: [{ type: "text", text: plan }], details: { received: true } };
    },
  });
}
`;

for (const manifestEntry of ["./", "./index.ts"]) {
  test(`real Pi permits npm-owned Plannotator plan submission from ${manifestEntry} without a sandbox`, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "sandbox-plannotator-loader-")));
    const cwd = join(directory, "project");
    const agentDir = join(directory, "agent");
    const packageRoot = join(agentDir, "npm/node_modules/@plannotator/pi-extension");
    const plan = "# Fixture plan\n\n- [ ] Review the proposed change\n";
    await mkdir(cwd);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(cwd, "PLAN.md"), plan);
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "@plannotator/pi-extension", version: "0.28.17", type: "module",
      pi: { extensions: [manifestEntry] },
    }));
    await writeFile(join(packageRoot, "index.ts"), fixturePlanSubmission);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
    try {
      const settingsManager = SettingsManager.inMemory({
        defaultProjectTrust: "always", packages: ["npm:@plannotator/pi-extension"],
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: [join(import.meta.dir, "../pi-devcontainer-sandbox/src/index.ts")],
      });
      await resourceLoader.reload();
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"), modelsPath: null,
        modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false,
      });
      created = await createAgentSession({
        cwd, agentDir, resourceLoader, modelRuntime, settingsManager,
        sessionManager: SessionManager.inMemory(cwd),
      });
      const tool = created.session.getAllTools().find((candidate) => candidate.name === "plannotator_submit_plan")!;
      expect(tool.sourceInfo.origin).toBe("package");
      expect(tool.sourceInfo.source).toBe("npm:@plannotator/pi-extension");
      expect(tool.sourceInfo.path).toBe(manifestEntry === "./" ? packageRoot : join(packageRoot, "index.ts"));
      expect(isAuthorizedHostTool(tool)).toBe(true);

      const notifications: string[] = [];
      await created.session.bindExtensions({
        mode: "rpc",
        uiContext: {
          notify(message: string) { notifications.push(message); },
          setStatus() {},
        } as unknown as ExtensionUIContext,
        onError: (error) => { throw new Error(error.error); },
      });
      const planSubmissionRequest: AssistantMessage = {
        role: "assistant",
        provider: "synthetic",
        api: "openai-completions",
        model: "fixture",
        timestamp: Date.now(),
        content: [{
          type: "toolCall",
          id: "plan-fixture",
          name: "plannotator_submit_plan",
          arguments: { filePath: "PLAN.md" },
        }],
        stopReason: "toolUse",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      created.session.agent.state.messages = [planSubmissionRequest];
      const ctx = created.session.extensionRunner.createToolContext("plan-fixture", undefined);
      const submission = await ctx.executeTool("plannotator_submit_plan", { filePath: "PLAN.md" });
      expect(submission.result.content).toEqual([{ type: "text", text: plan }]);
      expect(submission.isError).not.toBe(true);
      expect(submission.result.details).toEqual({ received: true });
      expect(notifications).toContain("Fixture plan received");

      const blockedRead = await ctx.executeTool("read", { path: "PLAN.md" });
      expect(blockedRead.isError).toBe(true);
      expect(JSON.stringify(blockedRead.result.content)).toContain("No devcontainer definition");
    } finally {
      if (created) {
        try {
          await created.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          created.session.dispose();
        }
      }
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
