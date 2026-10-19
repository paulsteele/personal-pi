import { afterEach, expect, it, vi } from "vitest";
import {
  registerSandboxToolRequests,
  requestSandboxTool,
} from "../src/sandbox/tool-installation.ts";
import type { SandboxSession } from "../src/sandbox/session.ts";
import type { SandboxStartupDisplay } from "../src/sandbox/startup-ui.ts";
import * as profileInstallation from "../src/sandbox/profile-tool-installation.ts";
import { globalToolProfilePath, projectToolProfilePath } from "../src/sandbox/tool-profile.ts";

const planner = vi.hoisted(() => vi.fn());
vi.mock("../src/sandbox/tool-prerequisites.ts", async (original) => ({
  ...(await original<typeof import("../src/sandbox/tool-prerequisites.ts")>()),
  findMissingPrerequisites: async () => [],
}));
vi.mock("../src/sandbox/image-tools.ts", () => ({ planImageTools: planner }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

const bunRequest = {
  tool: "bun",
  version: "1.3.0",
  command: ["npm", "install", "--global", "bun@1.3.0"],
  executable: "bun",
  prerequisites: ["npm"],
  reason: "This workspace requires Bun for its test scripts and lockfile.",
};

function installationFixture() {
  const confirm = vi.fn(
    async (_preview: string, _signal?: AbortSignal, _toolCallId?: string) => true,
  );
  const apply = vi.fn(async (_signal: AbortSignal) => {});
  const execute = vi.fn(async () => ({
    code: 0,
    output: Buffer.from("/usr/local/bin/bun\n"),
    stderr: "",
  }));
  const session = {
    options: {
      resolved: { path: "/agent/global/devcontainer.json", tier: "global" },
      confirm,
    },
    generation: 2,
    execute,
  } as unknown as SandboxSession;
  const preview =
    "Update active global devcontainer; affects future projects\nRUN bun installation";
  planner.mockResolvedValue({ preview, apply });
  return { session, confirm, apply, execute, preview, signal: new AbortController().signal };
}

it("previews a missing Bun installation before building and returns its guest executable", async () => {
  const fixture = installationFixture();
  fixture.confirm.mockImplementation(async () => {
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
    return true;
  });
  const result = await requestSandboxTool(
    fixture.session,
    bunRequest,
    fixture.signal,
    "install-bun",
  );
  expect(planner).toHaveBeenCalledExactlyOnceWith(
    fixture.session,
    [
      {
        id: "bun",
        version: "1.3.0",
        command: ["npm", "install", "--global", "bun@1.3.0"],
        executable: "bun",
        prerequisites: ["npm"],
        environment: {},
      },
    ],
    fixture.signal,
  );
  expect(fixture.confirm).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining(bunRequest.reason),
    fixture.signal,
    "install-bun",
  );
  const preview = fixture.confirm.mock.calls[0][0];
  expect(preview).toContain(fixture.preview);
  expect(preview).toContain("not on the host");
  expect(preview).toContain("language servers will restart");
  expect(fixture.apply).toHaveBeenCalledExactlyOnceWith(fixture.signal);
  expect(fixture.execute).toHaveBeenCalledExactlyOnceWith({
    command: ["sh", "-c", 'command -v "$1"', "sh", "bun"],
    signal: fixture.signal,
    timeoutMs: 10_000,
  });
  expect(result).toEqual({
    status: "installed",
    tool: "bun",
    requestedVersion: "1.3.0",
    executable: "/usr/local/bin/bun",
    definitionPath: "/agent/global/devcontainer.json",
    definitionTier: "global",
    containerGeneration: 2,
  });
});

it.each(["global", "project"] as const)(
  "uses the selected %s profile while retaining installation approval and runtime verification",
  async (scope) => {
    const fixture = installationFixture();
    const project = { kind: "projects" as const, id: "a".repeat(64), root: "/project" };
    Object.assign(fixture.session.options, {
      agentDir: "/agent",
      resolved: { ...fixture.session.options.resolved, project, layers: {} },
    });
    const planProfile = vi
      .spyOn(profileInstallation, "planProfileToolInstallation")
      .mockResolvedValue({
        preview: `Save private ${scope} tools`,
        apply: fixture.apply,
      });
    const result = await requestSandboxTool(
      fixture.session,
      bunRequest,
      fixture.signal,
      undefined,
      undefined,
      scope,
    );
    expect(planProfile).toHaveBeenCalledExactlyOnceWith(
      fixture.session,
      [
        {
          id: "bun",
          version: "1.3.0",
          command: ["npm", "install", "--global", "bun@1.3.0"],
          executable: "bun",
          prerequisites: ["npm"],
          environment: {},
        },
      ],
      fixture.signal,
      scope,
    );
    expect(planner).not.toHaveBeenCalled();
    expect(fixture.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`Save private ${scope} tools`),
      fixture.signal,
      undefined,
    );
    expect(fixture.apply).toHaveBeenCalledExactlyOnceWith(fixture.signal);
    expect(fixture.execute).toHaveBeenCalledExactlyOnceWith({
      command: ["sh", "-c", 'command -v "$1"', "sh", "bun"],
      signal: fixture.signal,
      timeoutMs: 10_000,
    });
    expect(result.toolScope).toBe(scope);
    expect(result.toolProfilePath).toBe(
      scope === "global"
        ? globalToolProfilePath("/agent")
        : projectToolProfilePath("/agent", project),
    );
  },
);

it("does not build or probe when the operator denies installation", async () => {
  const fixture = installationFixture();
  fixture.confirm.mockResolvedValue(false);
  await expect(
    requestSandboxTool(fixture.session, bunRequest, fixture.signal, "install-bun"),
  ).rejects.toThrow("not approved");
  expect(fixture.apply).not.toHaveBeenCalled();
  expect(fixture.execute).not.toHaveBeenCalled();
});

it("does not build when installation is cancelled during approval", async () => {
  const fixture = installationFixture();
  const cancellation = new AbortController();
  fixture.confirm.mockImplementation(async () => {
    cancellation.abort(new Error("Cancelled installation"));
    return true;
  });
  await expect(
    requestSandboxTool(fixture.session, bunRequest, cancellation.signal, "install-bun"),
  ).rejects.toThrow("Cancelled installation");
  expect(fixture.apply).not.toHaveBeenCalled();
  expect(fixture.execute).not.toHaveBeenCalled();
});

it("does not plan a request that was already cancelled", async () => {
  const fixture = installationFixture();
  await expect(
    requestSandboxTool(fixture.session, bunRequest, AbortSignal.abort(), "install-bun"),
  ).rejects.toThrow();
  expect(planner).not.toHaveBeenCalled();
  expect(fixture.confirm).not.toHaveBeenCalled();
});

it("reuses a matching saved installation without another approval or rebuild", async () => {
  const fixture = installationFixture();
  planner.mockResolvedValue(undefined);
  const result = await requestSandboxTool(
    fixture.session,
    bunRequest,
    fixture.signal,
    "install-bun",
  );
  expect(result.status).toBe("already_in_definition");
  expect(result.executable).toBe("/usr/local/bin/bun");
  expect(fixture.confirm).not.toHaveBeenCalled();
  expect(fixture.apply).not.toHaveBeenCalled();
  expect(fixture.execute).toHaveBeenCalledTimes(1);
});

it("reports a failed image build without probing or claiming installation succeeded", async () => {
  const fixture = installationFixture();
  fixture.apply.mockRejectedValue(new Error("Image build failed"));
  await expect(
    requestSandboxTool(fixture.session, bunRequest, fixture.signal, "install-bun"),
  ).rejects.toThrow("Image build failed");
  expect(fixture.execute).not.toHaveBeenCalled();
});

it("reports a tool that was not made available to the runtime user", async () => {
  const fixture = installationFixture();
  fixture.execute.mockResolvedValue({ code: 1, output: Buffer.alloc(0), stderr: "" });
  await expect(
    requestSandboxTool(fixture.session, bunRequest, fixture.signal, "install-bun"),
  ).rejects.toThrow("not available to the devcontainer runtime user");
  expect(fixture.apply).toHaveBeenCalledTimes(1);
});

it("keeps installation environment separate from the runtime executable probe", async () => {
  const fixture = installationFixture();
  const request = { ...bunRequest, environment: { INSTALL_PREFIX: "/opt/tools" } };
  await requestSandboxTool(fixture.session, request, fixture.signal, "install-bun");
  expect(planner).toHaveBeenCalledWith(
    fixture.session,
    [expect.objectContaining({ environment: { INSTALL_PREFIX: "/opt/tools" } })],
    fixture.signal,
  );
  expect(fixture.execute).toHaveBeenCalledExactlyOnceWith({
    command: ["sh", "-c", 'command -v "$1"', "sh", "bun"],
    signal: fixture.signal,
    timeoutMs: 10_000,
  });
});

it("keeps the installation screen open after rebuild until the runtime probe completes", async () => {
  const fixture = installationFixture();
  const stage = vi.fn();
  let screenOpen = false;
  const startup: SandboxStartupDisplay = {
    async run(_title, operation) {
      screenOpen = true;
      try {
        return await operation({ stage, output: vi.fn() });
      } finally {
        screenOpen = false;
      }
    },
  };
  fixture.session.options.startup = startup;
  fixture.apply.mockImplementationOnce(async () => {
    expect(screenOpen).toBe(true);
  });
  fixture.execute.mockImplementationOnce(async () => {
    expect(screenOpen).toBe(true);
    expect(stage).toHaveBeenCalledWith("Checking runtime executable bun (10-second timeout)…");
    return { code: 0, output: Buffer.from("/usr/local/bin/bun\n"), stderr: "" };
  });
  await requestSandboxTool(fixture.session, bunRequest, fixture.signal, "install-bun");
  expect(screenOpen).toBe(false);
});

it("reports the post-rebuild probe failure without reapplying or claiming installation success", async () => {
  const fixture = installationFixture();
  const report = vi.fn();
  fixture.execute.mockRejectedValueOnce(new Error("Guest process timed out"));
  await expect(
    requestSandboxTool(fixture.session, bunRequest, fixture.signal, "install-bun", report),
  ).rejects.toThrow("runtime executable probe for bun failed: Error: Guest process timed out");
  expect(fixture.apply).toHaveBeenCalledTimes(1);
  expect(report.mock.calls.map(([text]) => text)).toEqual([
    "Checking bun prerequisites in the sandbox image…",
    "Preparing bun (1.3.0) image installation…",
    "Rebuilding devcontainer image for bun…",
    "Devcontainer rebuild complete.",
    "Checking runtime executable bun (10-second timeout)…",
  ]);
});

it("preserves cancellation during the post-rebuild probe", async () => {
  const fixture = installationFixture();
  const cancellation = new AbortController();
  const reason = new Error("Operator cancelled installation");
  fixture.execute.mockImplementationOnce(async () => {
    cancellation.abort(reason);
    throw reason;
  });
  await expect(
    requestSandboxTool(fixture.session, bunRequest, cancellation.signal, "install-bun"),
  ).rejects.toBe(reason);
  expect(fixture.apply).toHaveBeenCalledTimes(1);
});

it("streams installation stages from the registered tool", async () => {
  const fixture = installationFixture();
  const registerTool = vi.fn();
  const update = vi.fn();
  registerSandboxToolRequests({ registerTool } as never, () => fixture.session);
  const tool = registerTool.mock.calls[0][0];
  await tool.execute("install-bun", bunRequest, fixture.signal, update);
  expect(update).toHaveBeenCalledWith({
    content: [{ type: "text", text: "Devcontainer rebuild complete." }],
    details: undefined,
  });
  expect(update).toHaveBeenLastCalledWith({
    content: [{ type: "text", text: "Runtime executable verified: /usr/local/bin/bun" }],
    details: undefined,
  });
});

it("registers a model-only sequential installation request tool", () => {
  const registerTool = vi.fn();
  registerSandboxToolRequests({ registerTool } as never, () => ({}) as SandboxSession);
  expect(registerTool).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      name: "request_sandbox_tool",
      exposure: "model-only",
      executionMode: "sequential",
    }),
  );
});
