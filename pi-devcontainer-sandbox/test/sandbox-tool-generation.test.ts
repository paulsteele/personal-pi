import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxSession } from "../src/sandbox/session.ts";
import { resolveSandboxProject } from "../src/sandbox/definition.ts";
import {
  addSandboxToolFromSettings,
  generateSandboxToolRecipe,
} from "../src/sandbox/tool-generation.ts";
import * as installation from "../src/sandbox/tool-installation.ts";

const directories: string[] = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const bunRecipe = {
  tool: "bun",
  version: "1.3.10",
  command: ["sh", "-c", "set -eu; install-bun 1.3.10 /usr/local/bin"],
  executable: "/usr/local/bin/bun",
  prerequisites: ["sh"],
  environment: {},
  reason: "Install the requested Bun release for development scripts.",
};

function generationFixture() {
  const signal = new AbortController().signal;
  const response = {
    stopReason: "toolUse",
    content: [{ type: "toolCall", name: "submit_tool_recipe", arguments: bunRecipe }],
  };
  const modelResult = vi.fn(async () => response);
  const streamSimple = vi.fn<ExtensionContext["modelRegistry"]["streamSimple"]>(
    () => ({ result: modelResult }) as never,
  );
  const model = { provider: "test", id: "recipe-model", reasoning: true };
  const ctx = { model, modelRegistry: { streamSimple } } as unknown as ExtensionContext;
  const execute = vi.fn(async () => ({
    code: 0,
    output: Buffer.from('ID=debian\nVERSION_ID="12"\naarch64\n'),
  }));
  const session = { execute } as unknown as SandboxSession;
  return { ctx, session, signal, model, streamSimple, modelResult, execute };
}

it("generates a structured recipe with Linux platform context, without executing the install", async () => {
  const fixture = generationFixture();
  const request = await generateSandboxToolRecipe(
    fixture.ctx,
    fixture.session,
    "bun 1.3.10",
    fixture.signal,
  );
  expect(request).toEqual(bunRecipe);
  expect(fixture.execute).toHaveBeenCalledExactlyOnceWith({
    command: ["sh", "-c", "cat /etc/os-release; uname -m"],
    timeoutMs: 10_000,
    signal: fixture.signal,
  });
  expect(fixture.streamSimple).toHaveBeenCalledExactlyOnceWith(
    fixture.model,
    {
      systemPrompt: expect.stringContaining("Do not execute commands"),
      messages: [
        {
          role: "user",
          content: expect.stringContaining(
            "Requested tool: bun 1.3.10\n\nSandbox platform:\nID=debian",
          ),
          timestamp: expect.any(Number),
        },
      ],
      tools: [
        {
          name: "submit_tool_recipe",
          description: expect.any(String),
          parameters: installation.sandboxToolRequestParameters,
        },
      ],
    },
    { signal: fixture.signal, maxTokens: 4096, reasoning: "low" },
  );
  expect(fixture.streamSimple.mock.calls[0][1].systemPrompt).toContain("never latest");
  expect(fixture.streamSimple.mock.calls[0][1].systemPrompt).toContain(
    "unavailable during this build",
  );
});

it.each([
  { scenario: "missing session level", thinkingLevel: undefined, expectedReasoning: "low" },
  { scenario: "selected medium", thinkingLevel: "medium", expectedReasoning: "medium" },
  { scenario: "selected high", thinkingLevel: "high", expectedReasoning: "high" },
  { scenario: "selected xhigh", thinkingLevel: "xhigh", expectedReasoning: "xhigh" },
  { scenario: "unsupported off", thinkingLevel: "off", expectedReasoning: "low" },
  { scenario: "unsupported minimal", thinkingLevel: "minimal", expectedReasoning: "low" },
] as const)("uses supported reasoning for a proxy model with $scenario", async (scenario) => {
  const fixture = generationFixture();
  Object.assign(fixture.model, {
    id: "amod-gpt-6.1-sol",
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
  });
  fixture.ctx.thinkingLevel = scenario.thinkingLevel;
  fixture.streamSimple.mockImplementation((_model, _context, options) => {
    if (!options?.reasoning) {
      throw new Error("reasoning_effort does not support none with this model");
    }
    return { result: fixture.modelResult } as never;
  });
  await expect(
    generateSandboxToolRecipe(fixture.ctx, fixture.session, "bun", fixture.signal),
  ).resolves.toEqual(bunRecipe);
  expect(fixture.streamSimple).toHaveBeenCalledExactlyOnceWith(fixture.model, expect.any(Object), {
    signal: fixture.signal,
    maxTokens: 4096,
    reasoning: scenario.expectedReasoning,
  });
});

it("omits reasoning for a model without thinking support", async () => {
  const fixture = generationFixture();
  fixture.model.reasoning = false;
  fixture.ctx.thinkingLevel = "high";
  await generateSandboxToolRecipe(fixture.ctx, fixture.session, "bun", fixture.signal);
  expect(fixture.streamSimple).toHaveBeenCalledExactlyOnceWith(fixture.model, expect.any(Object), {
    signal: fixture.signal,
    maxTokens: 4096,
    reasoning: undefined,
  });
});

it("preserves an explicit off setting for a model that supports it", async () => {
  const fixture = generationFixture();
  fixture.ctx.thinkingLevel = "off";
  await generateSandboxToolRecipe(fixture.ctx, fixture.session, "bun", fixture.signal);
  expect(fixture.streamSimple).toHaveBeenCalledExactlyOnceWith(fixture.model, expect.any(Object), {
    signal: fixture.signal,
    maxTokens: 4096,
    reasoning: undefined,
  });
});

it.each([
  { scenario: "empty command", arguments: { ...bunRecipe, command: [] } },
  { scenario: "invalid tool identifier", arguments: { ...bunRecipe, tool: "bun / invalid" } },
  { scenario: "missing reason", arguments: { ...bunRecipe, reason: undefined } },
])("rejects a generated recipe with $scenario", async (scenario) => {
  const fixture = generationFixture();
  fixture.modelResult.mockResolvedValue({
    stopReason: "toolUse",
    content: [{ type: "toolCall", name: "submit_tool_recipe", arguments: scenario.arguments }],
  } as never);
  await expect(
    generateSandboxToolRecipe(fixture.ctx, fixture.session, "bun", fixture.signal),
  ).rejects.toThrow("one valid pinned tool recipe");
});

it("rejects a response without a recipe submission", async () => {
  const fixture = generationFixture();
  fixture.modelResult.mockResolvedValue({ stopReason: "stop", content: [] });
  await expect(
    generateSandboxToolRecipe(fixture.ctx, fixture.session, "bun", fixture.signal),
  ).rejects.toThrow("one valid pinned tool recipe");
});

it("reports provider failure instead of treating its partial recipe as usable", async () => {
  const fixture = generationFixture();
  fixture.modelResult.mockResolvedValue({
    stopReason: "error",
    errorMessage: "Provider unavailable",
    content: [{ type: "toolCall", name: "submit_tool_recipe", arguments: bunRecipe }],
  } as never);
  await expect(
    generateSandboxToolRecipe(fixture.ctx, fixture.session, "bun", fixture.signal),
  ).rejects.toThrow("Provider unavailable");
});

it("cancels a pending model response without waiting for the provider", async () => {
  const fixture = generationFixture();
  const cancellation = new AbortController();
  fixture.modelResult.mockReturnValue(new Promise(() => {}));
  const pending = generateSandboxToolRecipe(
    fixture.ctx,
    fixture.session,
    "bun",
    cancellation.signal,
  );
  const rejected = expect(pending).rejects.toThrow("Cancelled generation");
  await vi.waitFor(() => expect(fixture.streamSimple).toHaveBeenCalledOnce());
  cancellation.abort(new Error("Cancelled generation"));
  await rejected;
});

async function settingsInstallationFixture(
  scenario: { toolName?: string; cancelGeneration?: boolean } = {},
) {
  const fixture = generationFixture();
  const directory = await mkdtemp(join(tmpdir(), "settings-tool-generation-"));
  directories.push(directory);
  const agentDir = join(directory, "agent");
  const root = join(directory, "project");
  await mkdir(root);
  const project = await resolveSandboxProject(root, agentDir);
  Object.assign(fixture.session, {
    revision: "active",
    options: { agentDir, resolved: { project, layers: {} } },
  });
  const getSession = vi.fn(() => fixture.session);
  const notify = vi.fn();
  const generateRecipePanel = async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
    const completion = Promise.withResolvers<unknown>();
    const component = await factory(
      { requestRender() {}, terminal: { rows: 24 } } as never,
      { fg: (_color: string, text: string) => text } as never,
      {} as never,
      completion.resolve,
    );
    try {
      if (scenario.cancelGeneration) {
        component.handleInput?.("\u001b");
      }
      return await completion.promise;
    } finally {
      (component as { dispose?(): void }).dispose?.();
    }
  };
  const custom = vi
    .fn(generateRecipePanel)
    .mockResolvedValueOnce(scenario.toolName ?? "bun 1.3.10");
  Object.assign(fixture.ctx, { cwd: root, isIdle: () => true, ui: { custom, notify } });
  const install = vi.spyOn(installation, "requestSandboxTool").mockResolvedValue({
    status: "installed",
    tool: "bun",
    requestedVersion: "1.3.10",
    executable: "/usr/local/bin/bun",
    definitionPath: "base.json",
    definitionTier: "global",
    containerGeneration: 2,
  } as never);
  return {
    ...fixture,
    agentDir,
    getSession,
    install,
    notify,
  };
}

it.each(["project", "global"] as const)(
  "routes the generated recipe to the %s installation approval/build workflow",
  async (scope) => {
    const fixture = await settingsInstallationFixture();
    await addSandboxToolFromSettings(
      fixture.ctx,
      fixture.agentDir,
      fixture.getSession,
      scope,
      fixture.signal,
    );
    expect(fixture.install).toHaveBeenCalledExactlyOnceWith(
      fixture.session,
      bunRecipe,
      fixture.signal,
      undefined,
      undefined,
      scope,
    );
    expect(fixture.notify).toHaveBeenCalledWith(
      `Installed bun (1.3.10) in ${scope} tools.`,
      "info",
    );
  },
);

it("installs a managed catalog tool without generating a recipe", async () => {
  const fixture = await settingsInstallationFixture({ toolName: "jscpd" });
  await addSandboxToolFromSettings(
    fixture.ctx,
    fixture.agentDir,
    fixture.getSession,
    "global",
    fixture.signal,
  );
  expect(fixture.streamSimple).not.toHaveBeenCalled();
  expect(fixture.install).toHaveBeenCalledExactlyOnceWith(
    fixture.session,
    expect.objectContaining({
      tool: "jscpd",
      version: "5.4.1",
      executable: "/opt/pi-tools/jscpd/5.4.1/bin/jscpd",
    }),
    fixture.signal,
    undefined,
    undefined,
    "global",
  );
});

it("leaves files and the container untouched when tool name entry is discarded", async () => {
  const fixture = await settingsInstallationFixture({ toolName: "" });
  await addSandboxToolFromSettings(
    fixture.ctx,
    fixture.agentDir,
    fixture.getSession,
    "project",
    fixture.signal,
  );
  expect(fixture.getSession).not.toHaveBeenCalled();
  expect(fixture.streamSimple).not.toHaveBeenCalled();
  expect(fixture.install).not.toHaveBeenCalled();
});

it("does not install a recipe after Escape cancels generation", async () => {
  const fixture = await settingsInstallationFixture({ cancelGeneration: true });
  fixture.modelResult.mockReturnValue(new Promise(() => {}));
  await addSandboxToolFromSettings(
    fixture.ctx,
    fixture.agentDir,
    fixture.getSession,
    "global",
    fixture.signal,
  );
  expect(fixture.install).not.toHaveBeenCalled();
  expect(fixture.notify).not.toHaveBeenCalled();
});

it("does not install after the sandbox changes during generation", async () => {
  const fixture = await settingsInstallationFixture();
  fixture.modelResult.mockImplementation(async () => {
    Object.defineProperty(fixture.session, "revision", { value: "changed" });
    return {
      stopReason: "toolUse",
      content: [{ type: "toolCall", name: "submit_tool_recipe", arguments: bunRecipe }],
    };
  });
  await expect(
    addSandboxToolFromSettings(
      fixture.ctx,
      fixture.agentDir,
      fixture.getSession,
      "global",
      fixture.signal,
    ),
  ).rejects.toThrow("sandbox changed while preparing");
  expect(fixture.install).not.toHaveBeenCalled();
});
