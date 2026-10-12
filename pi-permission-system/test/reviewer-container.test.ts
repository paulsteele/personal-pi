import { afterEach, expect, it, vi } from "vitest";
import { createReviewerContainer } from "../src/sandbox/reviewer-container.ts";

const ports = vi.hoisted(() => ({
  podman: vi.fn(),
  validateMount: vi.fn(),
  transport: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../src/sandbox/driver.ts", () => ({ podmanOutput: ports.podman }));
vi.mock("../src/sandbox/mounts.ts", async (original) => ({
  ...(await original<object>()),
  validateMountIdentity: ports.validateMount,
}));
vi.mock("../src/sandbox/reviewer-transport.ts", () => ({
  ReviewerFilesystemTransport: class {
    constructor(options: unknown) {
      ports.transport(options);
    }
    request = ports.request;
    close = ports.close;
    canonicalPaths = vi.fn(async (paths) => paths);
  },
}));
afterEach(() => vi.resetAllMocks());

function containerFixture() {
  const mount = {
    source: "/project",
    destination: "/workspace",
    access: "rw",
    identity: "1:2",
    kind: "directory",
  };
  const details = {
    Id: "a".repeat(64),
    Image: "sha256:prepared-image",
    State: { Running: true },
    Config: {
      Labels: {
        "pi.sandbox.session": "session",
        "pi.sandbox.role": "reviewer",
        "pi.sandbox.review-operation": "review",
        "pi.sandbox.review-task": "security",
      },
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      NetworkMode: "none",
      PidMode: "",
      SecurityOpt: ["no-new-privileges"],
      Devices: [],
    },
    EffectiveCaps: [],
    Mounts: [{ Type: "bind", Source: "/project", Destination: "/workspace", RW: false }],
  };
  const session = {
    revision: "revision",
    options: { sessionId: "session", agentDir: "/private-agent" },
    mounts: [mount],
    environment: {
      image: "sha256:prepared-image",
      container: "parent-container",
      user: "root",
      workspace: "/workspace",
    },
  };
  ports.podman.mockImplementation(async (args: string[]) => {
    if (args[0] === "run") {
      return details.Id;
    }
    if (args[0] === "inspect") {
      return JSON.stringify([details]);
    }
    return "";
  });
  ports.request.mockResolvedValue(true);
  ports.close.mockResolvedValue(undefined);
  const options = {
    session: session as never,
    operationId: "review",
    taskId: "security",
    signal: new AbortController().signal,
  };
  return { details, options, session };
}

it("reuses the prepared image with read-only mounts, no network, and one persistent probe transport", async () => {
  const fixture = containerFixture();
  const reviewer = await createReviewerContainer(fixture.options);
  const args = ports.podman.mock.calls[0]![0] as string[];
  expect(args).toContain("--pull=never");
  expect(args).toContain("--read-only");
  expect(args).toContain("--network=none");
  expect(args).toContain("--cap-drop=ALL");
  expect(args).toContain("--security-opt=no-new-privileges");
  expect(args).toContain("type=bind,source=/project,target=/workspace,readonly");
  expect(args).toContain("sha256:prepared-image");
  expect(args).not.toContain("parent-container");
  expect(args).not.toContain("--publish");
  expect(reviewer.mounts[0]!.access).toBe("ro");
  expect(fixture.session.mounts[0]!.access).toBe("rw");
  expect(ports.transport).toHaveBeenCalledOnce();
  await reviewer.close();
  await reviewer.close();
  expect(ports.close).toHaveBeenCalledOnce();
  const removals = ports.podman.mock.calls.filter(([call]) => call[0] === "rm");
  expect(removals).toHaveLength(1);
  expect(removals[0]).toEqual([
    ["rm", "--force", "--time=0", "--ignore", expect.stringMatching(/^pi-reviewer-/)],
    undefined,
    undefined,
    15_000,
  ]);
});

it.each([
  {
    scenario: "writable root filesystem",
    mutate: (fixture: ReturnType<typeof containerFixture>) => {
      fixture.details.HostConfig.ReadonlyRootfs = false;
    },
  },
  {
    scenario: "writable bind mount",
    mutate: (fixture: ReturnType<typeof containerFixture>) => {
      fixture.details.Mounts[0]!.RW = true;
    },
  },
  {
    scenario: "network access",
    mutate: (fixture: ReturnType<typeof containerFixture>) => {
      fixture.details.HostConfig.NetworkMode = "bridge";
    },
  },
  {
    scenario: "unexpected image",
    mutate: (fixture: ReturnType<typeof containerFixture>) => {
      fixture.details.Image = "sha256:other-image";
    },
  },
])("rejects $scenario and removes the child", async ({ mutate }) => {
  const fixture = containerFixture();
  mutate(fixture);
  await expect(createReviewerContainer(fixture.options)).rejects.toThrow();
  expect(ports.transport).not.toHaveBeenCalled();
  expect(ports.podman.mock.calls.at(-1)![0]).toEqual([
    "rm",
    "--force",
    "--time=0",
    "--ignore",
    expect.stringMatching(/^pi-reviewer-/),
  ]);
});

it("does not inherit approved private PR runtime mounts into reviewer containers", async () => {
  const fixture = containerFixture();
  fixture.session.mounts.push({
    source: "/private-agent/extensions/pr-review",
    destination: "/private-agent/extensions/pr-review",
    access: "ro",
    identity: "3:4",
    kind: "directory",
  });
  const reviewer = await createReviewerContainer(fixture.options);
  const args = ports.podman.mock.calls[0]![0] as string[];
  expect(args.some((argument) => argument.includes("/private-agent"))).toBe(false);
  expect(reviewer.mounts).toHaveLength(1);
  await reviewer.close();
});

it("does not spend the command timeout waiting for the disposable reviewer's graceful stop", async () => {
  const fixture = containerFixture();
  const execute = ports.podman.getMockImplementation()!;
  ports.podman.mockImplementation(async (...args) => {
    if (args[0][0] === "rm" && !args[0].includes("--time=0")) {
      throw Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
    }
    return execute(...args);
  });
  const reviewer = await createReviewerContainer(fixture.options);
  await expect(reviewer.close()).resolves.toBeUndefined();
  expect(ports.close).toHaveBeenCalledOnce();
});

it("includes Podman stderr and termination details when removal genuinely fails", async () => {
  const fixture = containerFixture();
  const execute = ports.podman.getMockImplementation()!;
  const removalFailure = Object.assign(new Error("Command failed"), {
    stderr: "Podman connection closed",
    killed: true,
    signal: "SIGTERM",
  });
  ports.podman.mockImplementation(async (...args) => {
    if (args[0][0] === "rm") {
      throw removalFailure;
    }
    return execute(...args);
  });
  const reviewer = await createReviewerContainer(fixture.options);
  await expect(reviewer.close()).rejects.toMatchObject({
    cause: removalFailure,
    message: expect.stringContaining(
      "Podman connection closed; Removal command terminated (timeout budget 15000ms); Signal: SIGTERM",
    ),
  });
});

it("still removes the container when transport closure fails and retains both cleanup errors", async () => {
  const fixture = containerFixture();
  const execute = ports.podman.getMockImplementation()!;
  const transportFailure = new Error("Transport did not close");
  ports.close.mockRejectedValue(transportFailure);
  ports.podman.mockImplementation(async (...args) => {
    if (args[0][0] === "rm") {
      throw Object.assign(new Error("Command failed"), {
        stderr: "Removal unavailable",
        code: 125,
      });
    }
    return execute(...args);
  });
  const reviewer = await createReviewerContainer(fixture.options);
  await expect(reviewer.close()).rejects.toMatchObject({
    errors: [
      transportFailure,
      expect.objectContaining({ message: expect.stringContaining("Removal unavailable") }),
    ],
  });
  expect(ports.podman.mock.calls.at(-1)![0][0]).toBe("rm");
});

it("cleans up partial startup when the persistent process never becomes ready", async () => {
  const fixture = containerFixture();
  ports.request.mockRejectedValue(new Error("conmon failed"));
  await expect(createReviewerContainer(fixture.options)).rejects.toThrow("conmon failed");
  expect(ports.close).toHaveBeenCalledOnce();
  expect(ports.podman.mock.calls.at(-1)![0][0]).toBe("rm");
});
