import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDelegatedReviewService } from "../src/delegated-review.ts";
import { createMountGrant } from "../src/sandbox/mounts.ts";
import { createSandboxService } from "../src/sandbox/service.ts";
import { PermissionScope, type SourceEffect } from "../../pr-review/permissions.ts";
import { ReviewerSandboxes } from "../src/sandbox/reviewer-sandboxes.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function sandboxReviewerFixture(isolatedReviewers = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pr-sandbox-permissions-")));
  directories.push(directory);
  const root = join(directory, "project");
  const privateStorage = join(directory, "private");
  await mkdir(root);
  await mkdir(privateStorage);
  const mount = await createMountGrant({
    path: root,
    destination: "/workspace",
    access: "rw",
    privateStorage,
  });
  let activeProbes = 0;
  let peakActiveProbes = 0;
  const canonicalPaths = vi.fn(async (paths: readonly string[]) => {
    activeProbes++;
    peakActiveProbes = Math.max(peakActiveProbes, activeProbes);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return [...paths];
    } finally {
      activeProbes--;
    }
  });
  const session = {
    options: { sessionId: "session" },
    revision: "authority",
    environment: { container: "container" },
    mounts: [mount],
    filesystem: { canonicalPaths },
    beforeContainerRetirement: () => () => {},
  };
  const sandbox = createSandboxService(session as never);
  const reviewerContainers: Array<{
    close: ReturnType<typeof vi.fn>;
    canonicalPaths: ReturnType<typeof vi.fn>;
  }> = [];
  const createReviewer = vi.fn(async () => {
    const container = {
      container: `reviewer-${reviewerContainers.length}`,
      mounts: [{ ...mount, access: "ro" as const }],
      canonicalPaths: vi.fn(async (paths: string[]) => paths),
      close: vi.fn(async () => {}),
    };
    reviewerContainers.push(container);
    return container;
  });
  const reviewers = new ReviewerSandboxes(
    session as never,
    async () => {},
    vi.fn(),
    createReviewer as never,
  );
  const service = createDelegatedReviewService({
    sessionId: () => "session",
    revision: () => sandbox.revision(),
    authority: () => [],
    maxSourcesPerBatch: 32,
    openTask: (spec, operation) => {
      if (isolatedReviewers) {
        return reviewers.openTask(spec, operation);
      }
      return undefined;
    },
    authorize: async (request) => {
      await sandbox.authorizeHostSources(
        [...new Set(request.effects!.map((source) => source.path))],
        request.signal,
      );
      return { kind: "allowed", revision: sandbox.revision() };
    },
  });
  const controller = new AbortController();
  const operation = service.service.open({
    id: "review",
    sessionId: "session",
    cwd: root,
    scope: "local",
    signal: controller.signal,
  });
  const reviewer = (id: string) =>
    new PermissionScope(
      operation.task({
        id,
        name: id,
        assignment: "Review captured source",
        model: "fixture",
        kind: "worker",
        tools: ["read"],
      }),
    );
  const sources: SourceEffect[] = Array.from({ length: 240 }, (_, index) => [
    { path: join(root, `file-${index}.ts`), side: "old" as const, version: "before" },
    { path: join(root, `file-${index}.ts`), side: "new" as const, version: "after" },
  ]).flat();
  return {
    reviewer,
    sources,
    canonicalPaths,
    service,
    reviewers,
    reviewerContainers,
    createReviewer,
    peakActiveProbes: () => peakActiveProbes,
  };
}

it("keeps concurrent reviewer preparation and provider rechecks bounded at the sandbox boundary", async () => {
  const fixture = await sandboxReviewerFixture();
  const reviewers = ["architecture", "correctness", "security", "readability"].map(
    fixture.reviewer,
  );
  try {
    await Promise.all(
      reviewers.map((reviewer) => reviewer.authorizeSources(fixture.sources, "Prepare")),
    );
    expect(fixture.canonicalPaths).toHaveBeenCalledTimes(60);
    expect(fixture.peakActiveProbes()).toBe(1);
    for (const reviewer of reviewers) {
      expect(reviewer.dependencies).toEqual(fixture.sources);
    }
    await Promise.all(reviewers.map((reviewer) => reviewer.beforeDispatch()));
    expect(fixture.canonicalPaths).toHaveBeenCalledTimes(120);
    expect(fixture.peakActiveProbes()).toBe(1);
    for (const [paths] of fixture.canonicalPaths.mock.calls) {
      expect(paths).toHaveLength(16);
    }
  } finally {
    await fixture.service.dispose();
    await fixture.reviewers.dispose();
  }
});

it("retires active operations without permanently disabling the delegated service", async () => {
  const fixture = await sandboxReviewerFixture(true);
  const first = fixture.reviewer("security");
  await first.authorizeSources(fixture.sources.slice(0, 1), "Prepare");
  await fixture.service.retireOperations();
  const freshOperationAfterRetirement = fixture.service.service.open({
    id: "after-tree",
    sessionId: "session",
    cwd: dirname(fixture.sources[0]!.path),
    scope: "local",
    signal: new AbortController().signal,
  });
  expect(freshOperationAfterRetirement).toBeDefined();
  expect(fixture.reviewerContainers[0]!.close).toHaveBeenCalledOnce();
  await freshOperationAfterRetirement.close();
  await fixture.service.dispose();
  await fixture.reviewers.dispose();
});

it("uses separate persistent reviewer transports for individual source checks and awaits task cleanup", async () => {
  const fixture = await sandboxReviewerFixture(true);
  const reviewers = ["security", "correctness", "architecture", "readability"].map(
    fixture.reviewer,
  );
  try {
    await Promise.all(
      reviewers.map((reviewer) => reviewer.authorizeSources(fixture.sources, "Prepare")),
    );
    expect(fixture.createReviewer).toHaveBeenCalledTimes(4);
    expect(fixture.canonicalPaths).not.toHaveBeenCalled();
    for (const container of fixture.reviewerContainers) {
      expect(container.canonicalPaths).toHaveBeenCalledTimes(480);
    }
    await Promise.all(reviewers.map((reviewer) => reviewer.beforeDispatch()));
    expect(fixture.createReviewer).toHaveBeenCalledTimes(4);
    for (const container of fixture.reviewerContainers) {
      expect(container.canonicalPaths).toHaveBeenCalledTimes(960);
    }
    await Promise.all(reviewers.map((reviewer) => reviewer.close()));
    for (const container of fixture.reviewerContainers) {
      expect(container.close).toHaveBeenCalledOnce();
    }
  } finally {
    await fixture.service.dispose();
    await fixture.reviewers.dispose();
  }
});

it("refuses a batched source outside the approved workspace without retaining any dependencies", async () => {
  const fixture = await sandboxReviewerFixture();
  const reviewer = fixture.reviewer("security");
  try {
    await expect(
      reviewer.authorizeSources(
        [fixture.sources[0]!, { path: join(tmpdir(), "unapproved-source.ts") }],
        "Prepare",
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(reviewer.dependencies).toEqual([]);
    expect(fixture.canonicalPaths).not.toHaveBeenCalled();
  } finally {
    await fixture.service.dispose();
    await fixture.reviewers.dispose();
  }
});
