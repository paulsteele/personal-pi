import type { SandboxSession } from "./session.ts";
import { createReviewerContainer, type ReviewerContainer } from "./reviewer-container.ts";
import { authorizeMappedSources } from "./service.ts";
import type { DelegatedTaskSpec, OpenDelegatedOperation } from "../delegated-review.ts";
import type { ToolReviewRequest, ToolReviewResult } from "../tool-review.ts";

export interface ReviewerSandboxLease {
  readonly maxSourcesPerBatch: 1;
  authorize(request: ToolReviewRequest): Promise<ToolReviewResult>;
  close(): Promise<void>;
}

function collectHostPaths(request: ToolReviewRequest): string[] {
  const effectPaths = [...new Set((request.effects ?? []).map((effect) => effect.path))];
  if (effectPaths.length > 0) {
    return effectPaths;
  }
  const requestedPath =
    request.input && typeof request.input === "object"
      ? (request.input as Record<string, unknown>).path
      : undefined;
  return typeof requestedPath === "string" ? [requestedPath] : [];
}

export class ReviewerSandboxes {
  private readonly leases = new Set<ReviewerSandboxLease>();
  private readonly unsubscribeRetirement: () => void;
  private disposed = false;

  constructor(
    private readonly session: SandboxSession,
    private readonly reviewPaths: (
      request: ToolReviewRequest,
      guestPaths: string[],
    ) => Promise<void>,
    private readonly reportCleanupError: (error: unknown) => void,
    private readonly createContainer: typeof createReviewerContainer = createReviewerContainer,
    private readonly disclosureRevision: () => string = () => session.revision,
  ) {
    this.unsubscribeRetirement = session.beforeContainerRetirement(() => this.retireLeases());
  }

  openTask(spec: DelegatedTaskSpec, operation: OpenDelegatedOperation): ReviewerSandboxLease {
    if (this.disposed) {
      throw new Error("Reviewer sandbox owner is retired");
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      operation.signal,
      ...(spec.signal ? [spec.signal] : []),
    ]);
    const authorityRevision = this.session.revision;
    let container: Promise<ReviewerContainer> | undefined;
    let containerCleanup: Promise<void> = Promise.resolve();
    let closing: Promise<void> | undefined;
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (this.session.revision !== authorityRevision) {
        throw new Error("Reviewer sandbox belongs to a retired sandbox revision");
      }
    };
    const ensureContainer = async () => {
      await containerCleanup;
      assertCurrent();
      container ??= this.createContainer({
        session: this.session,
        operationId: operation.id,
        taskId: spec.id,
        signal,
      });
      return container;
    };
    const closeContainer = () => {
      const currentContainer = container;
      container = undefined;
      containerCleanup = containerCleanup.then(async () => {
        if (currentContainer) {
          const ready = await currentContainer.catch(() => undefined);
          await ready?.close();
        }
      });
      return containerCleanup;
    };
    const abort = () => {
      void lease.close().catch(this.reportCleanupError);
    };
    const lease: ReviewerSandboxLease = {
      maxSourcesPerBatch: 1,
      authorize: async (request) => {
        try {
          assertCurrent();
          const permittedRevision = this.disclosureRevision();
          const ready = await ensureContainer();
          assertCurrent();
          request.signal?.throwIfAborted();
          const hostPaths = collectHostPaths(request);
          let guestPaths: string[] = [];
          if (hostPaths.length > 0) {
            guestPaths = await authorizeMappedSources({
              hostPaths,
              mounts: ready.mounts,
              revision: () => {
                assertCurrent();
                return this.session.revision;
              },
              canonicalPaths: (paths, callSignal) => ready.canonicalPaths(paths, callSignal),
              signal: request.signal,
            });
          }
          await this.reviewPaths(request, guestPaths);
          assertCurrent();
          return { kind: "allowed", revision: permittedRevision };
        } catch (error) {
          if (!signal.aborted && container) {
            try {
              await closeContainer();
            } catch (cleanupError) {
              this.reportCleanupError(cleanupError);
            }
          }
          return signal.aborted || request.signal?.aborted
            ? { kind: "cancelled", reason: "Reviewer sandbox cancelled" }
            : { kind: "unavailable", reason: `Reviewer sandbox unavailable: ${String(error)}` };
        }
      },
      close: () => {
        if (closing) {
          return closing;
        }
        signal.removeEventListener("abort", abort);
        controller.abort();
        closing = (async () => {
          try {
            await closeContainer();
          } finally {
            this.leases.delete(lease);
          }
        })();
        return closing;
      },
    };
    this.leases.add(lease);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    return lease;
  }

  private async retireLeases(): Promise<void> {
    const results = await Promise.allSettled([...this.leases].map((lease) => lease.close()));
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (errors.length) {
      throw new AggregateError(
        errors.map((result) => result.reason),
        "Reviewer sandbox cleanup failed",
      );
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribeRetirement();
    await this.retireLeases();
  }
}
