# Shared model-runtime cleanup investigation

## Context

Investigate whether PR subagents, the automatic permission classifier, the activity/progress summarizer, and the code-quality checker have enough shared machinery to justify cleanup. This is an investigation and implementation proposal only; no source changes are authorized during planning.

The user wants ranked, incremental recommendations. Scope is PR workers, the auto permission classifier, `progress-observer` (confirmed as the activity summarizer), and code quality—not Atelier's presentation adapters.

## Findings and investment ranking

**Yes: invest in consistent request boundaries and SDK types. Do not build a shared agent runtime.** The strongest commonality is among the three completion callers; PR's agent loop has different responsibilities.

| Priority | Investment | Evidence | Benefit / risk | Recommendation |
| --- | --- | --- | --- | --- |
| 1 | Use real SDK completion contracts | `pi-permission-system/src/auto/classifier.ts:148–160`, `progress-observer/observer.ts:235–247` duplicate `Model<never>`/`unknown` interfaces; both extension call sites need `as never`. Quality already uses registry-derived types. | Small scope, low behavioral risk; compiler checks the actual integration. | Do first; no shared module needed. |
| 2 | Guarantee host-side deadline/cancellation settlement | Classifier and observer await the provider directly. `code-quality/reviewer.ts:66–100` already races against abort. In-memory fake callers confirmed that classifier and observer can remain pending beyond their deadline. | High practical value, moderate behavioral risk because previously hanging calls will now settle. | Reuse quality's pattern locally; preserve each timeout scope. |
| 3 | Remove PR's non-UI dependency on its UI module | `pr-review/tasks.ts:3` and `pr-review/snapshot-store.ts:9` import `awaitWithSignal` from `work-ui.ts:10–28`. | Small, low-risk layering cleanup. | Separate companion change: move the existing helper, not the worker runtime. |
| Later | Common request metrics | PR has request-kind usage in `usage.ts`; quality stores requests/latency/raw usage; classifier and observer discard usage. | Useful only with a consumer for aggregate cost/latency; adds behavior and protocol decisions. | Defer as an observability feature, not deduplication. |
| Skip now | Generic submission parser, event publisher, model settings helper | Parsers differ in call cardinality and validation. Auto/observer share only a small latest-snapshot publisher; quality adds session revisions and per-tool history. Model selection already uses the registry. | Little code saved relative to extra policy options and dependencies. | Keep local. |

### Contracts that must remain distinct

| Component | Execution and timeout | Retry/submission policy | Failure/lifecycle owner |
| --- | --- | --- | --- |
| PR | Streaming `Agent`, tools, coverage and compaction; request inactivity timer refreshed by events, excluding permission waits | Provider `maxRetries: 1`; host recovery/continuation; executed `submit_result` checks coverage and permissions | Review task graph and recovery gate |
| Classifier | Completion; one deadline across up to three malformed-response attempts | First matching `submit_verdict`; normalizes `deny`/`defer` into human review; provider retries left at SDK defaults | Permission controller, authorization cache, human fallback |
| Observer | One completion per observation | First matching `submit_progress`; no host retry; provider retries left at SDK defaults | Scheduler coalescing, generation guards, last-summary retention |
| Quality | Completion; fresh deadline for each attempt | Five provider-failure budget with 2/4/6/8-second waits, SDK retries disabled, one validation repair; exactly one call plus edit validation | Blocking quality case and operator arbitration |

PR's manual auth/dispatch bridge is intentional: `pr-review/permission-boundaries.test.ts:264` requires rechecking permission revisions after delayed authentication or permit acquisition, immediately before provider dispatch. Keep `registryStream`, permission waits, and provider dispatch together.

Keep prompt construction and sanitization domain-specific as well: classifier context carries user authorization, observer context is a bounded/redacted session record, quality intentionally excludes the conversation, and PR works from permission-checked captured source.

### Existing SDK reuse and packaging constraint

The SDK already supplies model lookup, authentication, completion/streaming contracts, and provider-supported `timeoutMs`. That timeout option is not a guaranteed host-side deadline. Its generic `retryAssistantCall` uses exponential transient-error retries, unlike the local policies above.

Pi AI 0.87.1 exports `raceWithAbortSignal` via `./utils/*`. Direct ESM probes passed from all four workspace directories. However, an in-memory Jiti probe using Pi's Node-loader root alias reproduced a load failure: the subpath becomes `.../dist/compat.js/utils/abort`. The helper is not exported from the package root. Do not introduce that subpath dependency, bypass the loader, or change the SDK in this cleanup. A loader-safe root export would make it worth revisiting later.

`tests/package-integration.test.ts` requires independently packaged extensions, and each package has a pack verifier. A root-relative shared source import would not preserve that contract. A new runtime package, bundled copies, or a build-generation step is disproportionate to these small primitives.

## Approach

Deliver three independently reviewable changes, in ranked order:

1. **Typed completion callers.** Use `Pick<ExtensionContext["modelRegistry"], "complete">` and `Model<Api>` for classifier and observer; construct SDK-valid contexts, including timestamps on classifier messages. Remove the production `as never` bridges. Keep provider options, prompt text, accepted submission forms, and domain results unchanged. Update the focused tests with typed model/response fixtures; keep malformed payload scenarios explicit.
2. **Bounded completion waiting.** Adapt the existing quality request boundary inside `classify` and `observe`: check cancellation before dispatch, race completion against the combined deadline/caller signal, check again before accepting a result, and remove the abort listener and timer in `finally`. Late provider rejection remains observed. Classifier keeps one deadline outside its malformed-response loop; observer keeps one per observation. External cancellation maps to `cancelled`, timeout maps to the existing timeout result, and classifier `modelCalled` reflects whether dispatch occurred. Abort is best effort for the provider: the guarantee is that the host stops waiting and ignores late results, not that remote work has stopped. Leave quality production code unchanged as the reference implementation.
3. **PR helper placement.** Move `awaitWithSignal` to `pr-review/abort.ts`, update its consumers, and add direct contract tests. Preserve propagation of `signal.reason` and the existing fallback for nullish reasons. Retain UI-specific cancellation handling in `work-ui.ts`; leave `worker.ts` untouched.

Do not combine these changes with stricter submission cardinality, new retry policies, model defaults, config consolidation, telemetry channels, shared state machines, or a new package.

## Reuse

- `pr-review/worker.ts`: `registryStream`, `runWorker`.
- `code-quality/reviewer.ts:66–100`: `completeReviewAttempt` provides the strongest existing completion deadline behavior; `waitForRetry` keeps quality-specific retry delays cancellable.
- `pr-review/work-ui.ts:10–28`: move `awaitWithSignal` without changing abort reasons or late-rejection handling; do not reimplement it.
- Pi AI's `raceWithAbortSignal` is a future SDK reuse candidate, not a dependency to introduce now: its exported subpath fails under the inspected Pi/Jiti alias configuration.
- Installed `ModelRegistry` declarations: use `Pick<ExtensionContext["modelRegistry"], "complete">`, `Model<Api>`, `Context`, and `AssistantMessage` instead of fabricated `Model<never>` contracts.
- `pi-permission-system/src/auto/classifier.ts`: retain prompt generation, verdict normalization, and repair policy.
- `progress-observer/observer.ts` and `scheduler.ts`: retain prompt sanitation, summary validation, coalescing, and stale-generation suppression.

## Files to modify

**Typed callers and bounded waits:**
- `pi-permission-system/src/auto/classifier.ts`
- `pi-permission-system/src/permission-system.ts` — direct typed caller/model handoff.
- `pi-permission-system/test/classifier.test.ts`
- `progress-observer/observer.ts`
- `progress-observer/index.ts` — direct typed caller/model handoff.
- `progress-observer/observer.test.ts`
- `progress-observer/scheduler.test.ts` — observation timeout followed by a queued refresh.

**Separate PR helper extraction:**
- New `pr-review/abort.ts` and `pr-review/abort.test.ts`.
- `pr-review/work-ui.ts`, `pr-review/tasks.ts`, `pr-review/snapshot-store.ts` — helper imports/ownership.
- `pr-review/runner.test.ts` — helper import.
- `pr-review/verify-pack.mjs` — require the new runtime file in the packed contents (`*.ts` already includes it).

No root manifest, lockfile, configuration schema, event protocol, or quality production changes are required.

## Steps

- [x] Replace the fabricated completion interfaces and production casts; verify both package typechecks before changing cancellation behavior.
- [x] Add explicit scenarios for uncooperative providers, then apply quality's abort-race pattern without changing retry budgets or timeout placement.
- [x] Verify observer timeout releases its active slot so the queued latest observation can run; retain old-generation suppression.
- [x] Move PR's existing abort helper into its non-UI module and verify cancellation through UI, recovery, and snapshot callers.
- [x] Run focused and integration suites, package checks, and Pi loading checks; review each slice independently.

## Verification

### Completed during investigation

- Inspected all four request paths, their owners, focused tests, SDK declarations/implementations, and standalone packaging requirements.
- Ran file-free fake-provider probes: classifier and observer remained pending after a 10 ms deadline when the caller ignored abort.
- Ran file-free SDK probes: ESM imports and abort behavior passed; Jiti with Pi's root alias failed to resolve the helper subpath. No live model requests, installs, code changes, or full test-suite runs were performed.

### Implementation checks

- **Classifier:** pre-aborted call makes no request; active cancellation does not request stale human approval; timeout settles even if provider ignores abort; late success cannot approve an action; late rejection is handled; three malformed attempts share the original deadline; `require_human` is not retried. Preserve current normalization and first-matching-call behavior.
- **Observer:** same cancellation/deadline cases; failure retains the previous summary; a queued refresh can run after timeout; reset/dispose suppress late results. Preserve existing parsing/sanitization and no host retries.
- **Quality regression:** keep five provider-failure budget, 2/4/6/8-second delays, independent repair allowance, and per-attempt timeout behavior. Existing `code-quality/core.test.ts` includes an uncooperative-provider test.
- **PR helper:** normal resolution/rejection, pre-abort, active abort with explicit reason, listener cleanup, and late rejection; existing permission-boundary and worker tests must remain green.

Run focused tests using each package's test script, then:

```sh
bun run --cwd pi-permission-system test
bun run --cwd progress-observer test
bun run --cwd code-quality test
bun run --cwd pr-review test
bun run test:integration
bun run typecheck
bun run lint
bun run format:check
bun run check:pack
```

Finally load the affected extension entry points through Pi's actual extension loader, not only Bun/ESM imports. In TUI smoke checks, cancel an in-flight classifier/observation, confirm observer failure does not interrupt the main agent, and confirm PR cancellation still exits its work UI. Use fake providers for deterministic failure cases; any live-model smoke call is opt-in.
