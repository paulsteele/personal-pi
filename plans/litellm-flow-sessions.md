# LiteLLM sessions for auxiliary flows

## Context

PR review, the activity summarizer (`progress-observer`), automatic permission classification, and code-quality review should each have their own LiteLLM session within a Pi session. Auxiliary calls must not be grouped into the main model's session.

## Findings

- Activity, auto, and quality call `ctx.modelRegistry.complete`; PR calls `provider.streamSimple` through `pr-review/worker.ts:registryStream`.
- The installed `pi-provider-litellm@2.1.0` injects the main session's top-level `litellm_session_id` through `before_provider_request`. Pi wires that hook on its main Agent, not on these auxiliary request paths. No global provider-hook change is needed.
- LiteLLM documents `x-litellm-trace-id` as its highest-priority correlation header, stored as `LiteLLM_SpendLogs.session_id`. SDK `sessionId` instead controls caching/routing. PR already keeps separate routing IDs per logical worker and per compaction request; preserve them.
- PR setup discovery/profile generation and PR compaction all use the worker bridge. Tracking at that bridge covers them as well as review, verification, consolidation, and recovery.
- Registry completions merge request headers over authentication headers. PR owns its equivalent merge and its permission recheck immediately before provider dispatch.
- The packages must remain independently distributable. Standalone quality calibration has no owning Pi session and is outside this feature.

## Confirmed requirements

- One auxiliary LiteLLM session per flow per Pi session: PR, activity summarizer, auto, and quality.
- All PR workers, stages, and repeated PR invocations share the PR tracking session.
- Resuming a saved Pi session continues its auxiliary sessions. New, forked, or cloned Pi session IDs produce new groups; `/tree` stays in the same groups.
- Add correlation only when the actual auxiliary model's provider is exactly `litellm`. Do not infer LiteLLM from URL/model names, support aliases implicitly, or alter non-LiteLLM requests.

## Approach

### Identity and transport

Use `x-litellm-trace-id` with deterministic values:

| Flow | Tracking ID |
| --- | --- |
| PR, including setup | `pi-${encodeURIComponent(piSessionId)}-pr` |
| Activity summarizer | `pi-${encodeURIComponent(piSessionId)}-activity` |
| Auto classifier | `pi-${encodeURIComponent(piSessionId)}-auto` |
| Quality reviewer | `pi-${encodeURIComponent(piSessionId)}-quality` |

Read the parent from `ctx.sessionManager.getSessionId()`, not the session filename, environment, main model, or worker. Encoding makes custom Pi session IDs safe for HTTP headers. Tracking IDs contain no paths or prompt content. LiteLLM groups are created by calls, not pre-created when a flow is idle.

Add a distinctly named `piSessionId` input to the lower-level callers; keep PR's existing `sessionId` meaning unchanged. The real Pi entry points always supply the owner. Permit omission only for existing standalone callers such as calibration; omission adds no tracking and must not invent a random or main-session fallback.

Add the header only for `model.provider === "litellm"`. Preserve authentication and all unrelated request options. Make the flow trace override case-insensitive, including configured/auth/model headers, and verify that the final HTTP request contains exactly one trace value. Do not mutate the shared registry model or global headers. Reuse registry header merging where sufficient; keep any small normalization helper local to its package.

### Request ownership

- **Activity:** capture the owner when `createRuntime` creates the scheduler; pass it into every `observe` call. Refreshes and regenerated summaries reuse the same ID while a replacement runtime uses its new owner.
- **Auto:** capture the owner at the start of `modelDecision` and pass it into `classify`. All malformed-response retries reuse it. Delegated PR permission checks belong to the **auto** group, not the PR model group. Deterministic/cache-only decisions still make no model calls.
- **Quality:** capture the owner's plain ID when a boundary operation begins, before awaiting reconciliation/review. Pass it through `review` to `completeReviewAttempt`; all chunks, provider retries, validation repair, corrections, and disagreements for that Pi session share the quality ID. Do not key it by quality case or revision.
- **PR:** capture the owner at entry to runner `review` and `setup`, before asynchronous preparation. Pass it to every `runWorker`. Bind tracking to the `registryStream` closure so ordinary requests, continuations, host recovery, and compaction all share the PR tracking ID even when their SDK cache IDs differ.

Session changes must not relabel an already-started request or its retries. Keep existing cancellation and stale-generation guards; no additional session state store is needed.

### Boundaries

No new runtime dependency/shared package, configuration option, provider extension change, global request hook, or session-file migration. Do not change prompts, tools, permissions, retries, timeouts, usage accounting, cache retention, SDK routing IDs, or `previous_response_id`. Main-model follow-ups after auxiliary tools remain main-model calls.

## Files to modify

**Production:**
- `pr-review/runner.ts`, `pr-review/setup.ts`, `pr-review/worker.ts`.
- `progress-observer/index.ts`, `progress-observer/observer.ts`.
- `pi-permission-system/src/permission-system.ts`, `pi-permission-system/src/auto/classifier.ts`.
- `code-quality/controller.ts`, `code-quality/reviewer.ts`.

**Tests:**
- `pr-review/worker.test.ts`, `pr-review/cache.test.ts`, `pr-review/runner.test.ts`, `pr-review/setup.test.ts`; update affected synthetic context fixtures, including `pr-review/test-fixtures.ts`, to supply explicit parent session IDs.
- `progress-observer/index.test.ts`, `progress-observer/observer.test.ts`.
- `pi-permission-system/test/permission-system.test.ts`, `pi-permission-system/test/classifier.test.ts`.
- `code-quality/controller.test.ts`, `code-quality/core.test.ts`, `tests/code-quality-integration.test.ts`.
- New `tests/litellm-sessions-integration.test.ts` for provider-boundary request capture across the four flows.

**Documentation:** `pr-review/README.md`, `progress-observer/README.md`, `pi-permission-system/README.md`, `code-quality/README.md`: describe each suffix, resume/fork semantics, exact `litellm` provider scope, and the distinction from routing/cache identity.

No package manifest or lockfile changes are expected.

## Reuse

- `ctx.sessionManager.getSessionId()` and existing runtime/controller lifecycle ownership.
- SDK request `headers` and registry auth merging; keep PR's permission-aware `registryStream` rather than replacing it with a generic caller.
- `pr-review/cache.test.ts:scripted` already captures `SimpleStreamOptions` for continuations, failures, and compaction.
- Existing observer, permission, and quality harnesses capture completion options and exercise session replacement/disagreements.
- `tests/code-quality-integration.test.ts` provides `ModelRuntime`, `DefaultResourceLoader`, and in-memory Pi session integration patterns.
- [LiteLLM request-header contract](https://docs.litellm.ai/docs/proxy/request_headers): session correlation and header precedence. No import from the installed external LiteLLM package is needed.

## Steps

- [x] Confirm grouping, resume behavior, and provider scope.
- [x] Trace SDK/provider hooks, all auxiliary dispatch sites, and cache/session distinctions.
- [x] Add parent-session inputs and per-flow request headers to activity, auto, and quality; cover retries and standalone omission.
- [x] Thread PR ownership through setup/runner into the bridge; preserve worker and compaction routing and dispatch permissions.
- [x] Add lifecycle, cross-flow, and actual HTTP-header regression tests.
- [x] Document the behavior and run verification.

## Verification

### Deterministic tests

- For one parent Pi ID, assert the four exact tracking values are distinct from each other and from the main-model ID. Repeated calls and model changes within `litellm` retain the flow ID.
- Activity refreshes, auto retries and delegated checks, quality chunks/retries/repair/disagreements, and PR setup/stages/repeated runs/compaction all follow their flow's group.
- Resume/reload and `/tree` retain groups; new/fork/clone/switch operations use the target Pi ID. A delayed request remains attached to its original owner when a new runtime starts. Include an in-memory Pi session and an encoded custom-ID scenario.
- Preserve PR's existing assertions for unique concurrent worker `sessionId`s, stable recovery IDs, independent compaction IDs, and compaction `cacheRetention: "none"`.
- Non-LiteLLM providers, including similarly named aliases, receive no new tracking fields. A standalone reviewer without a parent gets no tracking field. No-call paths remain no-call paths.
- Through real SDK adapters with a synthetic/local HTTP transport, capture Chat Completions and Responses requests. Assert one flow trace header survives auth/model-header merging, including mixed-case preexisting trace headers, while unrelated headers and request bodies are preserved. Use synthetic credentials and no live provider calls.
- Confirm main-model requests retain their existing session identity and receive none of the auxiliary suffixes, including follow-ups to quality feedback. Reuse the real Pi integration fixture and a synthetic main-only payload hook rather than depending on the separately installed LiteLLM extension.

### Commands after implementation

```sh
bun run --cwd code-quality test
bun run --cwd pi-permission-system test
bun run --cwd progress-observer test
bun run --cwd pr-review test
bun run test:integration
bun run typecheck
bun run lint
bun run format:check
bun run check:pack
```

Load affected entry points through Pi's actual extension loader for a smoke check. With user opt-in for live calls, trigger each flow twice, inspect LiteLLM Admin UI session logs (or spend-log `session_id`), then resume and fork: verify four stable auxiliary groups, a separate unchanged main group, and new groups for the fork. Historical logs are not migrated.

Planning performed read-only inspection and documentation research; no source edits, installs, tests, or live model requests were run during planning.

### Implementation results

- Added request-local owner propagation and LiteLLM trace headers for all four flows, including PR setup/compaction, auto delegated checks, and quality repair/disagreement requests.
- Added real HTTP request-capture tests for Chat Completions and Responses, including case-insensitive trace replacement, unchanged bodies, non-LiteLLM exclusion, and standalone omission. A real in-memory Pi session verifies main/nested separation; lifecycle harnesses verify retained and replaced owners.
- `bun run check` passed: 888 tests passed, one existing test skipped; all package typechecks, lint, formatting, and pack checks passed. `git diff --check` passed.
- The installed Pi extension loader successfully loaded all four affected entry points.
- No live provider calls or LiteLLM server changes were made. Admin UI confirmation is still an opt-in smoke check; historical logs are unchanged.
