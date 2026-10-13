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
      workspace: "/workspace",
      configuration: {},
      container: "container",
      remoteEnvironment: { HOME: "/home/developer" },
    },
    filesystem: {
      canonical: async (path: string) => (path.startsWith("/") ? path : `/workspace/${path}`),
      entriesExist: async (paths: readonly string[]) =>
        paths.map((path) => existingPaths.includes(path)),
    },
  };
  return {
    session,
    agentDir,
    review: (command: string) =>
      reviewSandboxAction({
        session: session as never,
        agentDir,
        toolName: "bash",
        input: { command },
        ctx: { hasUI: false } as never,
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
    input,
    review: (signal?: AbortSignal) =>
      reviewSandboxToolCall({
        tool,
        getSession,
        agentDir,
        input,
        ctx: { signal } as never,
      }),
  };
}

it("permits the audited questionnaire UI without a ready container or an extra permission prompt", async () => {
  const fixture = await unavailableContainerFixture();
  const originalInput = structuredClone(fixture.input);
  await fixture.review();
  expect(fixture.getSession).not.toHaveBeenCalled();
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
      ctx: {} as never,
    }),
  ).rejects.toThrow("Tool denied by explicit policy");
});

it.each([
  { scenario: "container-local installation", command: "apt-get install -y curl" },
  { scenario: "destructive cleanup", command: "rm -rf /workspace/build" },
  { scenario: "remote mutation", command: "chmod +x build.sh && git push" },
  { scenario: "bare credential filename", command: "cat .env" },
  { scenario: "absolute credential filename", command: "cat /workspace/.env" },
  { scenario: "unresolved file operand", command: 'cat "$UNKNOWN_FILE"' },
  { scenario: "dynamic executable", command: '"$TOOL" build' },
  { scenario: "escaped executable", command: "c\\at .env" },
  { scenario: "opaque shell payload", command: 'bash -c "git push"' },
  { scenario: "eval payload", command: 'eval "cat .env"' },
])("permits $scenario without an interactive approval channel", async ({ command }) => {
  const fixture = await actionFixture();
  await expect(fixture.review(command)).resolves.toBeUndefined();
});

it("enforces a bare filename deny using its canonical protected symlink target", async () => {
  const fixture = await actionFixture(["/workspace/public"]);
  fixture.session.filesystem.canonical = async (path) =>
    path === "/workspace/public" ? "/workspace/private.txt" : path;
  await saveSandboxSettings(
    fixture.agentDir,
    parseSandboxSettings({
      permission: { path: { "/workspace/private.txt": "deny" } },
    }),
    undefined,
  );
  await expect(fixture.review("cat public")).rejects.toThrow("Shell path denied");
});

it("permits a bare symlink to a private key without interactive approval", async () => {
  const fixture = await actionFixture(["/workspace/public"]);
  fixture.session.filesystem.canonical = async (path) =>
    path === "/workspace/public" ? "/home/developer/.ssh/id_rsa" : path;
  await expect(fixture.review("cat public")).resolves.toBeUndefined();
});

it("checks relative and lexical aliases even when the canonical target is allowed", async () => {
  const fixture = await actionFixture();
  fixture.session.filesystem.canonical = async () => "/workspace/allowed.ts";
  await saveSandboxSettings(
    fixture.agentDir,
    parseSandboxSettings({
      permission: { path: { "src/private.ts": "deny" } },
    }),
    undefined,
  );
  await expect(
    reviewSandboxAction({
      session: fixture.session as never,
      agentDir: fixture.agentDir,
      toolName: "read",
      input: { path: "src/private.ts" },
      ctx: {} as never,
    }),
  ).rejects.toThrow("Path denied");
  await expect(fixture.review("cat src/private.ts")).rejects.toThrow("Shell path denied");
});

it("checks the full command deny in addition to its independently allowed units", async () => {
  const fixture = await actionFixture();
  const command = "echo ready && touch /workspace/result";
  await saveSandboxSettings(
    fixture.agentDir,
    parseSandboxSettings({
      permission: { bash: { [command]: "deny" } },
    }),
    undefined,
  );
  await expect(fixture.review(command)).rejects.toThrow("Shell command denied");
});

it("uses remote HOME to enforce explicit credential-directory denies", async () => {
  const fixture = await actionFixture();
  fixture.session.environment.remoteEnvironment.HOME = "/custom/home";
  await saveSandboxSettings(
    fixture.agentDir,
    parseSandboxSettings({
      permission: { path: { "/custom/home/.ssh/config": "deny" } },
    }),
    undefined,
  );
  await expect(fixture.review('cat "$HOME"/.ssh/config')).rejects.toThrow("Shell path denied");
});

it("permits direct credential-directory reads without interactive approval", async () => {
  const fixture = await actionFixture();
  fixture.session.environment.remoteEnvironment.HOME = "/custom/home";
  await expect(
    reviewSandboxAction({
      session: fixture.session as never,
      agentDir: fixture.agentDir,
      toolName: "read",
      input: { path: "/custom/home/.ssh/config" },
      ctx: { hasUI: false } as never,
    }),
  ).resolves.toBeUndefined();
});
