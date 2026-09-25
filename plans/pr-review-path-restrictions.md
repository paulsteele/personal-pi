# PR review permission integration — a foundation for future subagents

## Context

Make PR review use the real permission system and leave a clean integration point for future subagents. **Do not build a general runtime now.** Keep PR's agents, orchestration, schemas, coverage, compaction, independent verification, and browser workflow in PR.

This replaces the earlier deny-only snapshot patch. Audited against `1ee4e5d` (v1.1.2), including the recent report-file session grant. Preserve that behavior and all unrelated work. Only this plan has been changed. The scope is now larger than the original one-day path-check estimate; implement it in the tested stages below, with shared-hook/UI regressions as the main risk.

## Decisions confirmed with the user

- **Normal routing:** policy deny blocks; deterministic safety guards require a human; policy allow proceeds; `ask` uses the classifier with auto on and a human with auto off. Classifier failure escalates to a human, or blocks without UI.
- **Parent UI:** serialize human approval prompts, labeled with the worker and exact action.
- **Preserve existing features:** retain configured allow rules, explicit parent session-directory/file grants, and the main agent's existing turn-local classifier-allow optimization. Use the same optimization separately for each PR worker's turn; never share cached approvals across workers or introduce run-long grants. Human approvals are not cached. New turns, retries and relevant live policy/context changes invalidate cached automatic decisions.
- **Live policy and auto mode:** use the current global config and auto state at each permission/action boundary, for the main agent and PR alike. Filepath-rule edits and `/auto` changes take effect without restarting the review or reloading Pi. Recheck pending decisions before execution or disclosure so old approvals cannot override new rules.
- **One service owner:** require the already-loaded permission extension. Missing/incompatible service means no source-consuming PR work; no bundled fallback engine.
- **Capabilities remain separate:** PR stays snapshot-only/read-only. Approval never gives a worker shell, writes, arbitrary extension tools, or nested agents.

## Audit conclusions incorporated

1. **No runtime or packaging detour:** keep low-level Agents and use the existing in-process extension bus. Do not switch to SDK sessions, discover child extensions, add workspaces, bundle the permission package, or weaken package-content checks.
2. **A tool hook alone is insufficient:** capture, inline docs/diffs, direct patch readers, searches and cross-worker result transfer all bypass it today.
3. **No fake parent context:** the shared evaluator needs explicit actor, authority, cwd and cancellation inputs; never mutate `runtime.ctx` to impersonate a worker.
4. **Authorize real inputs, not speculative frameworks:** mandatory PR resources are already enumerated by coverage. Gate those before packing, retain the packer, and revalidate pending delivery under current rules before dispatch.
5. **Content caching is not authorization:** snapshot/blob caches may retain immutable bytes, but every new access still uses live policy. Preserve existing short-lived classifier memoization only within its scope and unchanged decision context; never treat cached bytes or host capture approval as worker authorization. Derived findings carry source dependencies to the receiving verifier/consolidator.
6. **Fix lifecycle/accounting edges:** slash-command launch authority, cancellable UI, stale in-flight decisions, parent-vs-child tool IDs, missing-vs-denied guidance, and permission denial vs retryable failure need explicit treatment.

## Approach

### 1. Share the existing evaluator; expose a narrow delegated service

Extract the current tool-call decision flow into a context-explicit module owned by `pi-permission-system`. The main hook and delegated requests call the **same** policy/path/guard/classifier logic. Preserve rule precedence, safeguards, UI, explicit grants and existing main-agent turn-local classifier memoization. Add live config refresh and stale-cache invalidation rather than deleting existing behavior.

Expose a versioned in-process discovery/open-operation contract through `pi.events`, following existing extension communication patterns. The service creates operation/task handles and owns their lifetime. It is not a model tool, socket, or general worker scheduler. Keep the small transport contract checked by integration tests; PR imports no second runtime engine.

- A PR operation opens the service before reading source or launching workers. Validate session ownership, protocol version and required methods; missing/duplicate/incompatible service responses fail closed.
- Strictly read/validate the existing global config when opening an operation, before evaluating each request, and before committing an awaited decision to execution/disclosure. Missing/invalid/unreadable config blocks that action; do not keep using a last-known-good policy or fallback defaults. No new policy config or automatic edits.
- Policy and auto mode share one live source of truth. No per-run rule copy, filesystem watcher dependency or new long-lived approval cache. Refresh policy before considering existing turn-local cached classifier results; changes invalidate them before reuse. A request-local revision also detects stale in-flight decisions. Refresh config in place—do not call the session `reload()` helper on every request and reset counters, explicit grants, notes or event subscriptions.
- If rules change while the classifier/human is deciding or while inputs are being prepared, discard the stale decision and evaluate the pending action under the current rules. A newly applicable deny blocks; `/auto off` routes an unresolved ask to a human. Never reuse the old allow to avoid re-evaluation.
- Return typed allowed/denied/cancelled/service-failure outcomes, not error-string protocols. No success-by-timeout and no `waitForIdle()` while the outer `pr_review` tool is awaiting children.
- A service failure or session replacement invalidates handles, queued prompts and pending decisions. Source-free commands (status/model/setup edit/approve) retain their current behavior.

“Live” means the next permission check, queued-prompt presentation, execution or outgoing-context boundary observes edits. Reading the config at these boundaries is authoritative; no `/reload` or new review is required. An already executing tool or provider request cannot be retroactively unexecuted.

### 2. Give each request explicit authority and identity

The trusted PR adapter supplies operation/task IDs, task label, cwd, actual tool name/arguments, declared read effects, parent tool ID when present, and an explicit abort signal. Tool effects and capabilities are code-owned, never accepted as model assertions.

Capture authoritative launch context once: relevant genuine parent user turns, plus the actual `/pr` command and scope for command launches. A tool-launched assignment, generated specialist focus, repository guidance and worker output are labeled delegated/untrusted context, not new user authorization. Render that distinction in the classifier prompt; merely setting today's unused `agentName` field is insufficient.

PR permission requests describe source paths/versions, intended use and bounded action metadata—not raw protected file contents or candidate bodies. Do not disclose the data to the classifier/UI in order to ask whether it may be read. Use code-owned summaries for PR result/bookkeeping arguments; preserve the existing main-agent edit-preview behavior separately.

Evaluate original repository paths—not snapshot-store filenames—with the task's repository-root cwd, lexical/canonical aliases, old/new sides and rename source paths. Preserve explicit actual-tool rules and evaluate declared file-read effects using the same path/read rules; an alias such as `read_before` must not evade a configured read/path deny. Batch effects cannot hide a denied member behind a tool-level allow.

Every model-invoked PR tool, including bookkeeping tools, goes through normal tool policy. Source effects require their own authorization even when a wrapper tool is allowed. Internal host bookkeeping is not fabricated as a model tool call. PR never registers shell/write tools or forwards arbitrary parent extensions.

### 3. Gate source capture and every route into a worker

Use two distinct scopes: **host preparation** and **individual worker consumption**. A preparation approval permits its stated local read/copy/diff work, not blanket disclosure to all reviewers.

| Boundary | Enforcement |
| --- | --- |
| Metadata discovery | Build scope from Git/path metadata without materializing source bodies. Keep existing filter, index-flag, symlink and containment protections. |
| Source capture | Authorize needed source before copying/hashing live bytes or materializing Git blobs. Scope excludes must be known before eagerly copying unrelated files. |
| Mandatory worker inputs | Authorize that worker's declared docs/diffs and source dependencies for the pending input delivery before packing. Before provider dispatch, verify the decision revision still matches current rules; re-evaluate if not. Keep `packInlineContext()` and coverage behavior. |
| Optional tools/context | Authorize actual calls and paths on demand through a task-bound snapshot view, including search, baseline/line/cursor reads and direct diff access. |
| Worker-to-worker results | Track each current-run worker output's conservative source read-set in host memory. Before passing candidates, discovery results or consolidated inputs to another worker, authorize that dependency set for the recipient. Model-written evidence lists cannot shrink it. |
| Host validation/export | Evidence validation, drift checks and browser export use current policy, not capture-time approval. Recheck before accepting fix feedback/handoff; withhold authorization if current rules prohibit the required source. Worker inputs never receive backing paths as an alternative access route. |

Keep raw backing-store access private to capture/host code; worker tools and input builders receive the authorized view. Check before object-ID cache access. Track approved access separately from successful delivery: only delivered content closes coverage.

For excluded/unneeded dirty files, retain metadata rather than copying contents merely to build a snapshot. If later needed, authorize and verify the original recorded identity before capturing; if it changed or cannot be established, fail with snapshot drift instead of using newer bytes. Immutable Git blobs remain lazily available. Do not fall back to the last commit merely because restricted dirty content was not hashed. Preserve exact fingerprints for authorized content and conservative refusal when restricted state prevents a trustworthy handoff.

Search must report denied/skipped paths or counts and preserve cursor progress; its current catch-all must not turn cancellation or permission failures into an apparently complete negative search. Distinguish absent saved guidance from policy-denied mandatory guidance.

### 4. Preserve existing permissions; avoid a new approval-cache system

The current `runtime.cache` stores **classifier-produced allows**, keyed by action facts and operator-note digest. It clears on each main-agent turn and on several control/context changes. It does not store human approvals, configured allow rules, or session-directory/file grants. Preserve this existing optimization and its turn lifetime; add invalidation for live config and relevant decision-context changes.

Every access still evaluates current deterministic policy and guards before any classifier-cache lookup. An existing cache entry never overrides a new deny, a guard, `/auto off`, or changed authority. Human approvals remain one-shot unless the user explicitly chooses an existing grant option.

**Confirmed:** PR uses the existing classifier-allow optimization with a separate cache per worker turn. This is memoization of an identical model verdict—not a new permission grant. There are no run-long receipts, file allowlists, TTLs or cross-worker approval sharing.

- A cache hit requires the same worker/turn, exact action and argument/effect facts, original source path/side/version/range, recipient, authoritative context, and current policy/auto/notes revisions. Preserve rule ordering when identifying the current policy. Different pages or paths are not identical just because they refer to the same cached blob.
- Clear worker caches at every child turn boundary and retry, and invalidate them when relevant live config, auto mode, classifier model, risk facts, notes or authority change. Reuse existing cache logic where possible rather than inventing a separate approval mechanism.
- Host capture/validation and pre-turn input preparation have no child turn to own such a cache, so they do not retain verdicts across requests. They never borrow the parent's or a worker's cached decisions.
- A human decision belongs only to its pending action and is never memoized. For a classifier decision, only the identical same-turn case above may reuse the verdict. Recheck current deterministic policy, guards, cancellation and decision revision after asynchronous waits and before execution/disclosure.
- Retain snapshot/blob caches, coverage records and provider prompt caches: they store content or delivery history, **not authority**. Read current policy before accessing cached source; a newly denied path remains denied even if its bytes are already cached.
- Retain source-dependency tracking. Before a new provider dispatch, check the dependencies of the outgoing context against current rules. If previously allowed history/summary now contains denied source, stop that worker rather than attempt unreliable redaction or retransmit it. Already completed provider calls cannot be recalled.
- Worker prompts offer one-shot approval/denial and optional notes, not new broad session/task grants. Existing explicit parent session-directory/report-file grants are preserved, checked after current deterministic denies, and not implicitly inherited by workers.
- Retry and continuation use current rules with a cleared turn cache; no prior worker-turn verdict or human approval is revived.

### 5. One cancellable approval queue in the parent

Use one permission prompt queue for main-agent and PR requests so their dialogs cannot overlap. Serialize only human interaction, not all classifiers or workers. Integrate waiting state with PR's existing dashboard; yield focus to the approval panel and preserve unrelated worker progress. Reuse execution-permit suspension at safe task boundaries, without nested suspensions from parallel tool callbacks.

Carry operation, worker, request and child-call IDs separately. Existing `toolCallId` events attach to the real outer `pr_review` call; slash-command activity uses standalone permission records. Add bounded delegated labels to prompt/transcript/task details without inventing parent tool rows. Preserve classifier → human/security provenance and existing notifications.

Pass explicit cancellation through classifier calls, queued/visible prompts and optional note input. Queued cancellation never opens a dialog; active cancellation dismisses it and blocks execution. Refresh policy before presenting a queued prompt and recheck policy, signal and service generation after the answer and before execution. A stale answer cannot approve work under changed rules or approve the next request. A classifier note intentionally added with this same approval remains metadata for later requests; it must not itself trigger a repeat approval dialog. Current deterministic denies still win. Record one terminal action outcome; show superseded/re-evaluated decisions accurately rather than as executed approvals. No arbitrary human-response timeout.

### 6. Denial, compatibility and completion rules

- Denied optional context returns a clear tool error with no data or coverage credit; allowed alternatives remain usable.
- Denied in-scope changes, mandatory inputs, result-transfer dependencies, or required final submission prevent a complete review. Preserve typed failure through worker/runner layers so generic recovery does not repeatedly reprompt or turn it into a clean result.
- Do not open a fix-authorizing browser/handoff for an incomplete permission-blocked run. Keep permission-blocked work explicitly resumable via `/pr retry` after the operator changes policy or resolves the issue; retry reads current rules and clears prior turn verdicts. Do not automatically reprompt on denial. Normal transient failures retain Retry/Cancel. Reuse only the same valid source snapshot—source drift still requires a fresh review.
- Setup discovery and profile generation receive separate task scopes; never persist new required-reading references that were denied, and preserve the active approved profile on failure.
- Existing profiles remain usable; no automatic setup regeneration. Older approved summaries/reports are not retroactively scrubbed or provenance-reconstructed. Current-run derived transfers are tracked; document the legacy-data limit.
- Preserve worker concurrency defaults, request timeouts, usage/cache accounting, scope coverage and verification independence. Attribute permission activity separately rather than counting classifier calls as reviewer turns.

## Non-goals and security limits

No general subagent runtime/tool, new worker roles, recursive delegation, live write/shell workers, generic tool discovery, SDK-session migration, new config surface, runtime bundling, or global deployment. The permission service is a reusable integration boundary, not a framework.

This remains a decision layer, not an OS sandbox. Git can internally inspect files while computing metadata/status; trusted extension code, provider authentication and private runtime storage remain infrastructure. Do not promise that a path policy detects identical secrets in an independently allowed file, retracts already sent context, or removes historical artifacts.

## Files to modify

| Files | Responsibility |
| --- | --- |
| `pi-permission-system/src/permission-system.ts`, `config.ts` as needed; new `tool-review.ts`, `delegated-review.ts`, `approval-queue.ts` | Shared evaluator, live strict config loading, preservation/invalidation of existing turn-local classifier caching, stale-decision checks, owner/service lifecycle and parent queue. Exact module splits may be consolidated. |
| `pi-permission-system/src/auto/classifier.ts`, `permission-events.ts`, `prompt/{component,payload,entries}.ts` | Delegated authority/facts, correlation, scoped approval wording and cancellation. Reuse existing policy/guard/parser modules. |
| New `pr-review/permissions.ts`; `index.ts`, `setup.ts`, `runner.ts`, `worker.ts` | Service client, launch/task contexts, normal tool gating, mandatory input authorization and typed failures. |
| `pr-review/snapshot.ts`, `snapshot-store.ts`, `findings.ts`, `batching.ts` as needed | Authorized views, pre-capture checks, explicit host reads, source dependencies and no direct-patch delivery bypass. Preserve the packer and existing storage where possible. |
| `pr-review/tasks.ts`, `dashboard.ts`, `types.ts`, `report.ts` as needed | Permission waiting/blocked state, bounded attribution, backward-compatible reports. |
| Package/unit tests, `tests/package-integration.test.ts`, PR host-compatibility tests, Atelier/notification integration tests | Routing parity, cancellation/concurrency, source non-disclosure and service compatibility. |
| Both packages' README/changelog; permission `FORK.md`; pack-verification required-file lists | Document service dependency, live policy/auto behavior, isolated turn-local classifier reuse, preserved explicit grants, one-shot human decisions and security limits. Keep existing package privacy exclusions and load order. |

No new runtime package dependency, lockfile churn, TypeScript resolution migration or Atelier layout redesign is planned.

## Reuse

- `policyForCall`, `classifyFacts`, `modelDecision`, `humanDecision` in `permission-system.ts`: extract their behavior, do not reimplement a PR policy.
- `loadConfig`/`configPath`, `checkPolicy`, `PathNormalizer`/`AccessPath`, `BashProgram`, `evaluateSafety`, `classify` and existing classifier repair/deadline handling.
- `pi.events`, existing discovery patterns and `session-files.ts` lifecycle conventions; no fake `tool_call` events or raw shared-context mutation.
- Existing prompt rendering, durable entries, event consumers, `TaskStore`, `RecoveryGate`, `boundedMap` and cancellation helpers.
- `safePath`, snapshot backing/cache, `contextResources`, `CoverageLedger`, `packInlineContext`, evidence validation and fake-provider/Git fixtures.

## Steps

- [x] Extract the context-explicit evaluator and add main/delegated routing parity tests; preserve existing grants, safeguards and main-agent turn-local memoization while adding live config/invalidation.
- [x] Add the versioned delegated service, strict live policy/auto handling, explicit task identity and stale-decision checks. Reuse turn-local classifier memoization separately per worker, with turn/retry/context invalidation; test failure/retirement without long-lived grants.
- [x] Add the shared cancellable human queue and attributed prompt/events; verify parent/worker concurrency and dashboard interaction.
- [x] Connect PR launch/capture/setup scopes and source authorization; implement task-bound snapshot access and conservative deferred-source/drift behavior.
- [x] Gate worker tools, mandatory inline inputs, optional reads and current-run cross-worker result dependencies. Preserve PR coverage, packing, verification and usage.
- [x] Integrate typed denied/cancelled outcomes, retry/completion rules and backward-compatible activity/reporting; preserve the exact parent report-file grant.
- [x] Finish integration/security regressions, documentation and package checks. Inspect the diff for unrelated changes; do not modify the real config, regenerate real profiles or deploy.

## Verification

Use temporary agent directories, synthetic repositories, fake model providers and a real in-process permission owner/client pair. Mocking every decision to allow is not sufficient.

1. **Parity:** identical main/delegated operations produce the same rule selection and deny/guard/allow/auto/manual outcomes. Cover ordered exceptions, aliases, sensitive files, generic tools, Bash safety in the shared engine, malformed classifier replies, failure and no-UI fallback.
2. **Real PR routing:** forced `ask` yields observable classifier calls; policy allow makes none; policy deny and guards cannot be overruled. Worker capability restrictions remain effective even when permission approves.
3. **Authority:** command launches work before a chat turn; tool launches preserve real user intent; injected repository/assignment text cannot become authoritative. Classifier prompts actually contain the correct worker, cwd and action facts.
4. **Live policy and compatible turn-local reuse:** prove an identical repeated auto-approved request makes one classifier call within the same worker turn, while another worker, another turn, a retry, different arguments/page/source version, or changed decision context requires fresh classification. Human decisions are never cached. Test allow→deny, ask→allow, auto on→off, classifier/notes changes during queued/in-flight work, packing and browser feedback. Edits take effect without restart or `/reload`; invalid/deleted config blocks rather than retaining old permissions. Preserve the main agent's existing optimization and explicit grant UI/behavior.
5. **Non-disclosure:** sentinels must not reach unauthorized backing copies, tool results, inline prompts, candidate transfers, verifier/consolidator/setup inputs, reports or browser patches. Exercise every read/page/count/search/diff path and direct-patch route. Approval must occur before source bytes are read, except documented Git metadata internals.
6. **Capture/scope:** unchanged/dirty/untracked/deleted/renamed/mode-only source, profile exclusions, subdirectory invocation, unborn/clean/committed-only/base reviews and staged reverts. No false clean fallback; deferred changed source produces drift rather than newer context. Retain filter/symlink/index-flag protections.
7. **UI/lifecycle:** two workers plus a main request, one visible approval at a time, unrelated progress, optional note cancellation, Esc, `/pr cancel`, tree navigation/reload/shutdown, and late classifier/human completion. No orphaned IDs, stuck waits, double outcomes or leaked subscriptions.
8. **Completion/retry:** denied required context/derived transfers yield incomplete outcomes and no fix authorization; optional denials are explicit, search incompleteness is visible, and no coverage is credited. An explicit retry after a live rule change re-evaluates blocked work against the same valid snapshot. No automatic denial retry or resurrection of old approvals. Newly denied source in an outgoing history/summary blocks that provider dispatch.
9. **Compatibility:** no duplicate extension registration or new runtime imports; missing service fails only source-consuming PR operations; existing setup approvals, reports, notifications, usage and saved-report grants still work. Existing package privacy checks remain strict.

Run after implementation:

```sh
bun run --cwd pi-permission-system check
bun run --cwd pr-review check
bun run test:integration
bun run --cwd pi-atelier test
bun run test:custom
```

Use the opt-in installed-host compatibility probe when available. In a disposable TUI smoke test, run two workers, verify identical requests reuse only their own turn-local classifier result, edit filepath rules while requests are queued/in flight, toggle `/auto`, and use `/pr retry` without restarting. Verify new rules defeat stale verdicts and cached source, human approvals are not reused, and existing parent session grants still work without overriding denies. Use fake providers where possible and ask before real model-backed testing. No installs, code edits, or artifact-writing test runs during planning.
