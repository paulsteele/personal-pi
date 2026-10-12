import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { reviewSandboxAction, reviewSandboxToolCall } from "../src/sandbox/gate.ts";
import { parseSandboxSettings, saveSandboxSettings } from "../src/sandbox/settings.ts";
import { configPath } from "../src/config.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
  directories.length = 0;
});
async function actionFixture(existingPaths: readonly string[] = ["/workspace/.env"]) {
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "sandbox-gate-")));
  directories.push(agentDir);
  const session = {
    revision: "authority-1",
    mounts: [],
    environment: {
      workspace: "/workspace", configuration: {}, container: "container",
      remoteEnvironment: { HOME: "/home/developer" },
    },
    filesystem: {
      canonical: async (path: string) => (path.startsWith("/") ? path : `/workspace/${path}`),
      entriesExist: async (paths: readonly string[]) => paths.map((path) => existingPaths.includes(path)),
    },
  };
  const requests: string[] = [];
  return {
    requests,
    session,
    agentDir,
    review: (command: string) =>
      reviewSandboxAction({
        session: session as never,
        agentDir,
        toolName: "bash",
        input: { command },
        toolCallId: "tool-1",
        ctx: {} as never,
        confirm: async (_context, category) => {
          requests.push(category);
          return false;
        },
      }),
  };
}

const questionnaireTool = {
  name: "ask_user_question",
  sourceInfo: {
    path: "/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question/index.ts",
    source: "npm:@juicesharp/rpiv-ask-user-question",
    scope: "user",
    origin: "package",
  },
} as ToolInfo;

async function unavailableContainerFixture(tool: ToolInfo = questionnaireTool) {
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "sandbox-ui-gate-")));
  directories.push(agentDir);
  const getSession = vi.fn(() => {
    throw new Error("Mandatory sandbox is unavailable");
  });
  const confirm = vi.fn(async () => false);
  const input = {
    questions: [
      {
        header: "Approach",
        question: "Which implementation do you prefer?",
        options: [
          { label: "Simple", description: "Use the smaller implementation." },
          { label: "Flexible", description: "Keep more configuration choices." },
        ],
      },
    ],
  };
  return {
    agentDir,
    getSession,
    confirm,
    input,
    review: (signal?: AbortSignal) =>
      reviewSandboxToolCall({
        tool,
        getSession,
        agentDir,
        input,
        toolCallId: "question-1",
        ctx: { signal } as never,
        confirm,
      }),
  };
}

it("permits the audited questionnaire UI without a ready container or an extra permission prompt", async () => {
  const fixture = await unavailableContainerFixture();
  const originalInput = structuredClone(fixture.input);
  await fixture.review();
  expect(fixture.getSession).not.toHaveBeenCalled();
  expect(fixture.confirm).not.toHaveBeenCalled();
  expect(fixture.input).toEqual(originalInput);
});

it("keeps an explicit tool deny effective for the audited questionnaire", async () => {
  const fixture = await unavailableContainerFixture();
  await saveSandboxSettings(
    fixture.agentDir,
    parseSandboxSettings({ permission: { ask_user_question: "deny" } }),
    undefined,
  );
  await expect(fixture.review()).rejects.toThrow("Tool denied by explicit policy");
  expect(fixture.getSession).not.toHaveBeenCalled();
});

it("does not require legacy sandbox migration just to ask the user a question", async () => {
  const fixture = await unavailableContainerFixture();
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

it("does not pass a cancelled questionnaire to the UI", async () => {
  const fixture = await unavailableContainerFixture();
  await expect(fixture.review(AbortSignal.abort())).rejects.toThrow();
  expect(fixture.getSession).not.toHaveBeenCalled();
});

it("still blocks guest execution when the container is unavailable", async () => {
  const fixture = await unavailableContainerFixture({
    name: "bash",
    sourceInfo: { path: "/installed/pi-permission-system/src/index.ts" },
  } as ToolInfo);
  await expect(fixture.review()).rejects.toThrow("Mandatory sandbox is unavailable");
  expect(fixture.getSession).toHaveBeenCalledTimes(1);
});

it("rejects a questionnaire lookalike from an unknown extension before any execution", async () => {
  const fixture = await unavailableContainerFixture({
    ...questionnaireTool,
    sourceInfo: { ...questionnaireTool.sourceInfo, path: "/unknown/questionnaire.ts" },
  });
  await expect(fixture.review()).rejects.toThrow(
    "not integrated with the mandatory sandbox boundary",
  );
  expect(fixture.getSession).not.toHaveBeenCalled();
});

it("keeps explicit policy denies effective for sandbox tool installation requests", async () => {
  const fixture = await unavailableContainerFixture({
    name: "request_sandbox_tool",
    sourceInfo: { path: "/installed/pi-permission-system/src/index.ts" },
  } as ToolInfo);
  await saveSandboxSettings(
    fixture.agentDir,
    parseSandboxSettings({ permission: { request_sandbox_tool: "deny" } }),
    undefined,
  );
  await expect(
    reviewSandboxToolCall({
      tool: {
        name: "request_sandbox_tool",
        sourceInfo: { path: "/installed/pi-permission-system/src/index.ts" },
      } as ToolInfo,
      getSession: () => ({}) as never,
      agentDir: fixture.agentDir,
      input: { tool: "bun", command: ["npm", "install", "--global", "bun@1.3.0"] },
      toolCallId: "install-bun",
      ctx: {} as never,
      confirm: fixture.confirm,
    }),
  ).rejects.toThrow("Tool denied by explicit policy");
  expect(fixture.confirm).not.toHaveBeenCalled();
});

it("permits container-local install and cleanup without prompting", async () => {
  const fixture = await actionFixture();
  await fixture.review("apt-get install -y curl");
  await fixture.review("rm -rf /workspace/build");
  expect(fixture.requests).toEqual([]);
});

it("retains external-effect guards after a container-local operation", async () => {
  const fixture = await actionFixture();
  await expect(fixture.review("chmod +x build.sh && git push")).rejects.toThrow("Human denied");
  expect(fixture.requests).toEqual(["vcs_remote_mutation"]);
});

it("requires human approval to access a bare credential filename", async () => {
  const fixture = await actionFixture();
  await expect(fixture.review("cat .env")).rejects.toThrow("Human denied");
  expect(fixture.requests).toEqual(["sensitive_path"]);
});

it("enforces a bare filename deny using its canonical protected symlink target", async () => {
  const fixture = await actionFixture(["/workspace/public"]);
  fixture.session.filesystem.canonical = async (path) => path === "/workspace/public" ? "/workspace/private.txt" : path;
  await saveSandboxSettings(fixture.agentDir, parseSandboxSettings({
    permission: { path: { "/workspace/private.txt": "deny" } },
  }), undefined);
  await expect(fixture.review("cat public")).rejects.toThrow("Shell path denied");
  expect(fixture.requests).toEqual([]);
});

it("requires approval for a bare symlink to a private key", async () => {
  const fixture = await actionFixture(["/workspace/public"]);
  fixture.session.filesystem.canonical = async (path) => path === "/workspace/public" ? "/home/developer/.ssh/id_rsa" : path;
  await expect(fixture.review("cat public")).rejects.toThrow("Human denied");
  expect(fixture.requests).toEqual(["sensitive_path"]);
});

it("checks relative and lexical aliases even when the canonical target is allowed", async () => {
  const fixture = await actionFixture();
  fixture.session.filesystem.canonical = async () => "/workspace/allowed.ts";
  await saveSandboxSettings(fixture.agentDir, parseSandboxSettings({
    permission: { path: { "src/private.ts": "deny" } },
  }), undefined);
  const confirm = vi.fn(async () => true);
  await expect(reviewSandboxAction({
    session: fixture.session as never, agentDir: fixture.agentDir, toolName: "read",
    input: { path: "src/private.ts" }, toolCallId: "relative-deny", ctx: {} as never, confirm,
  })).rejects.toThrow("Path denied");
  await expect(fixture.review("cat src/private.ts")).rejects.toThrow("Shell path denied");
  expect(confirm).not.toHaveBeenCalled();
});

it("checks the full command deny in addition to its independently allowed units", async () => {
  const fixture = await actionFixture();
  const command = "echo ready && touch /workspace/result";
  await saveSandboxSettings(fixture.agentDir, parseSandboxSettings({
    permission: { bash: { [command]: "deny" } },
  }), undefined);
  await expect(fixture.review(command)).rejects.toThrow("Shell command denied");
  expect(fixture.requests).toEqual([]);
});

it("requires human approval for unresolved access operands", async () => {
  const fixture = await actionFixture();
  await expect(fixture.review('cat "$UNKNOWN_FILE"')).rejects.toThrow("Human denied");
  expect(fixture.requests).toEqual(["unresolved_path"]);
});

it("uses remote HOME for credential-directory safety instead of guessing from the configured user", async () => {
  const fixture = await actionFixture();
  fixture.session.environment.remoteEnvironment.HOME = "/custom/home";
  await expect(fixture.review('cat "$HOME"/.ssh/config')).rejects.toThrow("Human denied");
  expect(fixture.requests).toEqual(["sensitive_path"]);
});

it("uses guest HOME for direct credential-directory reads", async () => {
  const fixture = await actionFixture();
  fixture.session.environment.remoteEnvironment.HOME = "/custom/home";
  const confirm = vi.fn(async () => false);
  await expect(reviewSandboxAction({
    session: fixture.session as never,
    agentDir: fixture.agentDir,
    toolName: "read",
    input: { path: "/custom/home/.ssh/config" },
    toolCallId: "read-credential-directory",
    ctx: {} as never,
    confirm,
  })).rejects.toThrow("Human denied");
  expect(confirm).toHaveBeenCalledWith(expect.anything(), "sensitive_path", expect.any(String));
});

it("requires fresh human approval for recognizable sensitive files", async () => {
  const fixture = await actionFixture();
  await expect(fixture.review("cat /workspace/.env")).rejects.toThrow("Human denied");
  expect(fixture.requests).toEqual(["sensitive_path"]);
});
