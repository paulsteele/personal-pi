import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewerSandboxes } from "../src/sandbox/reviewer-sandboxes.ts";
import { createMountGrant } from "../src/sandbox/mounts.ts";
import type { ToolReviewRequest } from "../src/tool-review.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function reviewerFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "reviewer-lease-")));
  directories.push(directory);
  const root = join(directory, "project");
  const storage = join(directory, "private");
  await mkdir(root);
  await mkdir(storage);
  const mount = await createMountGrant({
    path: root,
    destination: "/workspace",
    access: "rw",
    privateStorage: storage,
  });
  const retirementListeners = new Set<() => Promise<void>>();
  const session = {
    revision: "initial",
    beforeContainerRetirement(listener: () => Promise<void>) {
      retirementListeners.add(listener);
      return () => {
        retirementListeners.delete(listener);
      };
    },
  };
  const containers: Array<{
    container: string;
    close: ReturnType<typeof vi.fn>;
    canonicalPaths: ReturnType<typeof vi.fn>;
  }> = [];
  const createContainer = vi.fn(async ({ taskId }: { taskId: string }) => {
    const container = {
      container: `container-${taskId}`,
      mounts: [{ ...mount, access: "ro" as const }],
      canonicalPaths: vi.fn(async (paths: string[]) => [...paths]),
      close: vi.fn(async () => {}),
    };
    containers.push(container);
    return container;
  });
  const reviewPaths = vi.fn(async () => {});
  const report = vi.fn();
  const owner = new ReviewerSandboxes(
    session as never,
    reviewPaths,
    report,
    createContainer as never,
  );
  const controller = new AbortController();
  const operation = {
    id: "review",
    sessionId: "session",
    cwd: root,
    scope: "local",
    signal: controller.signal,
  };
  const open = (id: string) =>
    owner.openTask(
      { id, name: id, assignment: "review", model: "fixture", tools: ["read"], kind: "worker" },
      operation,
    );
  const request: ToolReviewRequest = {
    toolName: "read",
    input: { path: join(root, "a.ts") },
    cwd: root,
    toolCallId: "read",
    effects: [{ path: join(root, "a.ts") }],
    signal: controller.signal,
  };
  return {
    owner,
    open,
    request,
    containers,
    createContainer,
    reviewPaths,
    session,
    retirementListeners,
    controller,
  };
}

it("gives each reviewer its own container while reusing its transport across checks", async () => {
  const fixture = await reviewerFixture();
  const security = fixture.open("security");
  const correctness = fixture.open("correctness");
  expect(fixture.createContainer).not.toHaveBeenCalled();
  expect(await security.authorize(fixture.request)).toEqual({
    kind: "allowed",
    revision: "initial",
  });
  expect(await security.authorize(fixture.request)).toEqual({
    kind: "allowed",
    revision: "initial",
  });
  expect(await correctness.authorize(fixture.request)).toEqual({
    kind: "allowed",
    revision: "initial",
  });
  expect(fixture.containers.map((container) => container.container)).toEqual([
    "container-security",
    "container-correctness",
  ]);
  expect(fixture.containers[0]!.canonicalPaths).toHaveBeenCalledTimes(2);
  expect(fixture.reviewPaths).toHaveBeenCalledTimes(3);
  expect(security.maxSourcesPerBatch).toBe(1);
  await security.close();
  await security.close();
  expect(fixture.containers[0]!.close).toHaveBeenCalledOnce();
  expect(fixture.containers[1]!.close).not.toHaveBeenCalled();
  await fixture.owner.dispose();
  expect(fixture.containers[1]!.close).toHaveBeenCalledOnce();
});

it("awaits reviewer cleanup before parent sandbox retirement and rejects reuse", async () => {
  const fixture = await reviewerFixture();
  const reviewer = fixture.open("security");
  await reviewer.authorize(fixture.request);
  for (const retire of fixture.retirementListeners) {
    await retire();
  }
  expect(fixture.containers[0]!.close).toHaveBeenCalledOnce();
  expect(await reviewer.authorize(fixture.request)).toMatchObject({ kind: "cancelled" });
  await fixture.owner.dispose();
});

it("blocks checks after a parent revision change without falling back to the parent container", async () => {
  const fixture = await reviewerFixture();
  const reviewer = fixture.open("security");
  await reviewer.authorize(fixture.request);
  fixture.session.revision = "replacement";
  expect(await reviewer.authorize(fixture.request)).toMatchObject({ kind: "unavailable" });
  expect(fixture.containers[0]!.canonicalPaths).toHaveBeenCalledOnce();
  await fixture.owner.dispose();
});

it("replaces a failed reviewer transport on retry without replacing sibling containers", async () => {
  const fixture = await reviewerFixture();
  const reviewer = fixture.open("security");
  await reviewer.authorize(fixture.request);
  fixture.containers[0]!.canonicalPaths.mockRejectedValueOnce(new Error("transport exited"));
  expect(await reviewer.authorize(fixture.request)).toMatchObject({ kind: "unavailable" });
  expect(fixture.containers[0]!.close).toHaveBeenCalledOnce();
  expect(await reviewer.authorize(fixture.request)).toMatchObject({ kind: "allowed" });
  expect(fixture.createContainer).toHaveBeenCalledTimes(2);
  await fixture.owner.dispose();
  expect(fixture.containers[1]!.close).toHaveBeenCalledOnce();
});

it("cancels container startup and closes a container returned after cancellation", async () => {
  const fixture = await reviewerFixture();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = fixture.createContainer.getMockImplementation()!;
  fixture.createContainer.mockImplementation(async (options) => {
    await ready;
    return original(options);
  });
  const reviewer = fixture.open("security");
  const pending = reviewer.authorize(fixture.request);
  await vi.waitFor(() => expect(fixture.createContainer).toHaveBeenCalledOnce());
  fixture.controller.abort();
  release();
  expect(await pending).toMatchObject({ kind: "cancelled" });
  await fixture.owner.dispose();
  expect(fixture.containers[0]!.close).toHaveBeenCalledOnce();
});
