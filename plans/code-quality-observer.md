# Code quality gate — implementation plan

## Release implementation notes — v1.4.0

This plan preserves the original approved design and checklist. Subsequent user decisions supersede the affected design details below:

- The shared readability preferences are enforced requirements. Formatting, unused-symbol cleanup, correctness, coverage, performance, security, and API compatibility are explicitly outside reviewer scope.
- Same-file hunks are grouped within the input budget. The requested task and main conversation remain excluded; bounded disagreement text is supplied as untrusted argument for reconsideration.
- Corrections and disagreements share five response-and-review rounds after initial rejection. Automatic operator arbitration waits for five unresolved rounds; disagreement no longer escalates immediately.
- Enter resolves a selected operator choice directly. `n` opens optional notes, and submitting notes resolves without another confirmation.
- Atelier now displays a Quality/model header below auto mode and compact quality badges inline with the corresponding tool calls. Transcript logs show `Checking Quality...`, then `approved` or `handling rejection N`, with full feedback expandable.
- Runtime snapshots are retained; automatic pruning is not implemented. Formal live calibration and the full long-session smoke checklist remain incomplete, so step 7 stays open. See [verification status](code-quality-verification.md).

## Context

The user wants persistent coding-style instructions plus an isolated side-model assessment of code after edits/writes. The reviewer returns `approved` or `needs_work`, with actionable rationale delivered to the executing agent. This should improve naming, structure, tests, and comment discipline throughout long sessions, not merely count comments.

The 20-example interview established: descriptive locals for simple calculations and invariants; meaningful predicates/operations and test-setup helpers even for single use; explicit test assertions; avoid helpers that only relocate clear calls or require unnecessary argument plumbing; protect requirements with tests; allow concise verified workaround rationale; allow bounded nearby cleanup. Prefer source-specific normalization before shared behavior where appropriate.

## Approach

Implement a separate `code-quality` extension, not part of the permission classifier or passive progress observer. Inject a concise versioned policy into the primary agent's persistent system context and supply the same policy plus calibrated examples to an isolated model with only a structured verdict-submission tool. Assess exact post-batch content snapshots and deliver bounded, revision-checked feedback. The side model may propose exact edits but has no filesystem tools, editing power, or security authority.

Selected runtime: interactive TUI only; explicit inactive status outside TUI. The reviewer provider/model is explicitly configured through the plugin's configuration and `/quality-model` selector, following the existing plugins' configuration pattern. There is no default reviewer model and no fallback to the observer or main agent's model. Arbitration uses the terminal review panel. User notes affect only the current case and its correction rounds, not the global policy or later cases.

Scope: all edited text files, not just source/tests. Apply conservative, purpose-aware rules to prose/configuration; preserve useful explanations, ADR rationale, changelog history, required comments, and configuration semantics. Known generated and lock files are out of scope: a hardcoded filename exclusion table auto-approves them without reading their bodies for review, sending them to the model, or opening correction cases. Distinguish `auto_approved` (excluded filename) from model/user approval in receipts. Binary/non-UTF-8 content not already excluded is visibly outside text coverage. Sensitive, over-budget, externally located, or unsupported-tool content that is not excluded pauses for an explicit user decision; never label incomplete coverage model-approved.

Resolve one case before unrelated implementation. Reading/testing remains available; edits stay within the case's explicit file scope, with a user-confirmed scope expansion for additional helper/test files. User approval is final for the exact chosen content: record user-approved separately from model-approved and filename-based auto-approval. Case notes do not silently modify policy or later cases.

Confirmed: review at assistant edit-batch boundaries, using changes plus bounded surrounding code, without conversation or executing-agent rationale. Initial automatic coverage is explicit edit/write tools only.

Approval is mandatory: in-scope changes must obtain `approved`, unless the user intervenes; excluded filenames auto-approve deterministically. Explicit agent disagreement opens user arbitration immediately. Initial rejection starts a case; allow five correction-and-review attempts before mandatory arbitration. The user chooses `accept original` (the latest agent-written snapshot under review), `accept proposed` (a concrete reviewer-supplied patch against that snapshot), or `allow another five cycles`, each with optional notes. The reviewer may propose changes but cannot apply them. Infrastructure failures allow five attempts total: attempt immediately, then retry after 2s, 4s, 6s, and 8s; after exhaustion pause for the user's decision. The proposed 10s wait is unused because there is no sixth attempt. Infrastructure attempts do not consume correction cycles.

## Files to modify

- New `code-quality/index.ts`: hooks, commands, policy injection, and the agent's structured `quality_response` tool.
- New `code-quality/{capture,exclusions,reviewer,case,proposal,state,ui,config}.ts` and focused tests: bounded snapshots/diffs, hardcoded filename exclusions, verdict/proposal validation, gate state machine, persisted case state, terminal arbitration, and configuration.
- New `code-quality/policy.md`, `examples.md`, and calibration fixtures covering the interview plus document/config cases.
- New `code-quality/{package.json,tsconfig.json,biome.json,vitest.config.ts,verify-pack.mjs,README.md,CHANGELOG.md}` following existing workspace conventions.
- Root `package.json`, `bun.lock`, `.pi/settings.json`, `README.md`, `tests/package-integration.test.ts`, and new `tests/code-quality-integration.test.ts`: eighth extension, scripts, load order, and integration coverage. Load after Permission System and before passive observer/Atelier consumers.
- Upgrade Pi development dependencies across root and all existing workspace manifests to exact 0.87.1, using host-supplied Pi packages as peers. Update existing checks/documentation that encode the previous target. No global pi install/update in this work.
- Compatibility fixes only where demonstrated by the upgrade: notably `pr-review/{worker,worker-context}.ts`, `progress-observer/{observer,index}.ts`, `pi-permission-system/src/permission-system.ts` and prompt components, `pi-atelier/src/{split-pane,sidebar}.ts` and corresponding tests/docs. Preserve existing behavior and security boundaries.
- No automatic edits to `~/.pi/agent/AGENTS.md`. The extension injects its canonical policy into a named system-prompt section; document how to use the policy standalone in AGENTS.md when the extension is not loaded.

## Reuse

- `progress-observer/README.md`: isolated side-model, strict runtime configuration, single-flight/coalescing, timeout handling, stale-state reset, and privacy documentation patterns. It is intentionally TUI-only and never steers; those limitations cannot simply carry over to this feature.
- `progress-observer/index.ts`: model resolution via `ctx.modelRegistry.find`, configured-auth checks, model-selection commands, and runtime disposal patterns. `observer.ts` uses `modelRegistry.complete` with a fresh system/user context and a single submission tool; `scheduler.ts` supplies cancellation/generation patterns, not a suitable mandatory-gate state machine. `config.ts` provides strict global-config and atomic-save patterns.
- `pi-permission-system/src/auto/classifier.ts`: `classify` uses a structured `submit_verdict` tool, combined cancellation/timeout signals, and at most two malformed-output retries. Reuse the approach, not permissive verdict parsing or security policy. New quality verdict validation must reject multiple/unknown submissions and missing actionable findings. Source-body exclusion in the permission classifier remains unchanged.
- `pr-review/index.ts` and `pr-review/compatibility.test.mjs`: generation/cancellation and installed-host synthetic integration-test patterns. Do not invoke the PR-review pipeline or require `/pr setup` for this style gate.
- Installed Pi 0.87.1 has actionable `turn_end` and `agent_before_settle` boundary results (`entries`, `continue`); repo 0.84.2 declarations have notification-only `turn_end` and no `agent_before_settle`. Upgrade the repository to supported current APIs and verify all extensions; no legacy gate adapter.
- Pi `tool_result` provides successful-operation input/result; `turn_end` provides the completed tool batch. Calls in a batch may execute concurrently. Capturing preimages, successful mutations, and settled batch postimages must not depend on sibling event order.
- Installed `examples/extensions/questionnaire.ts` and built-in `ctx.ui.select`/`editor` show user-choice and notes interaction patterns. Existing permission UI is security-specific; avoid coupling its decision types to style arbitration.
- Prefer current Pi's public `generateDiffString`, `generateUnifiedPatch`, and `renderDiff` exports for snapshot diffs and terminal previews. `pr-review/exact-diff.ts` is disk/worker-oriented and unnecessarily coupled for this bounded use; do not import it or the PR-review pipeline.

## Gate contract

### Policy and isolated review

- Add the canonical policy through `before_agent_start` structured `systemPromptOptions.sections`, not by replacing the full prompt. Include the active gate protocol/status and avoid duplicate policy copies. Pi preserves system context through compaction; restore unresolved-case reminders from state as necessary.
- Every reviewer request has a fresh context: trusted policy/examples, file kind, exact before/after change excerpts with line numbers, revision identifiers, and optional case-only user notes. No conversation, hidden reasoning, task transcript, autonomous repository browsing, or agent justifications. Clearly delimit source/proposals as untrusted data, including AGENTS.md and prompt files being edited.
- Re-review against the open case's initial pre-batch baseline, not only the most recent correction, so an unresolved issue cannot disappear from review scope. Supply bounded previous finding identifiers/locations to check resolution, not a growing model conversation.
- Require exactly one `submit_quality_verdict` call. `approved` requires a bounded rationale and no findings/proposal. `needs_work` requires concrete findings (file, location/quote, policy rule, rationale) and one coherent proposed edit set covering the findings. `approved` means only that reviewed changes meet this policy, not that functionality is verified. `auto_approved` is host-owned exclusion status, not an additional model verdict.
- Proposed edits use exact `oldText`/`newText`, must match uniquely and not overlap in the captured postimage, and can target only supplied case files/context. Validate by applying to an in-memory copy; store/render the resulting diff. No fuzzy matching, shell patches, external paths, invented bug references, or arbitrary new dependencies. If context is insufficient for a demonstrable local improvement, do not demand a speculative refactor.
- Bound response size and finding count. Malformed, contradictory, out-of-scope, or non-applicable proposals are infrastructure/validation failures, never approval. All retries count against the same five-attempt request budget.

### Filename exclusions

- Keep one source-owned, hardcoded table in `code-quality/exclusions.ts`, with no model-based classification or content-marker detection. Initial exact basenames: `bun.lock`, `bun.lockb`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `composer.lock`, `packages.lock.json`, `project.assets.json`, `go.sum`, `pubspec.lock`, `Podfile.lock`, and `Package.resolved`.
- Include explicit, narrow generated-filename patterns in the same table: `*.g.cs`, `*.g.i.cs`, `*.generated.cs`, `*.generated.ts`, `*.generated.tsx`, `*.gen.go`, `*.pb.go`, `*.g.dart`, and `*.freezed.dart`. Match basenames deterministically, case-sensitively; do not use broad `*.lock`, build-directory exclusions, or source comments claiming that a file is generated. Additional unconventional generated filenames require a deliberate table update, not reviewer inference.
- Apply exclusions before review-body capture, size/sensitivity checks, model selection, and correction-scope checks. For symlinked paths, require the requested and canonical target names to qualify; a lockfile alias must not exempt an ordinary source target. Permission checks still run normally, and failed tool execution is never relabeled successful.
- Excluded files always pass the quality check without a model call, source snapshot, proposal, or correction-cycle charge. Emit a compact `auto_approved` receipt with the filename/rule and `reviewed: false`. Mixed batches review only nonexcluded targets. Changes to excluded files cannot clear an open in-scope case.

### Capture and coverage

1. Observe canonical `edit`/`write` calls after Permission System approval. Apply the filename exclusions, then capture the first preimage per in-scope target per batch before execution; do not read blocked targets at `tool_execution_start` (that event precedes permission checks). Recognize current multi-edit arguments and legacy normalization without guessing arbitrary custom-tool semantics.
2. At `turn_end`, reconcile actual postimages for attempted targets after sibling tools have settled. Same-file edits coalesce; unchanged operations/no-op batches require no model call. A failed/aborted write that changed content remains pending.
3. Hash canonical path/content and retain absence for new files. Build exact diffs with 20 context lines, preserving all changed lines. A new file's entire content is changed scope. Keep source formatting intact, not the observer's whitespace-collapsing sanitization.
4. Initial resource defaults: 256 KiB per text file, 1 MiB per batch, 64,000 serialized input characters per reviewer request (also constrained by the model's declared context window), 8,000 output tokens or the model's smaller limit, and a 30-second timeout per attempt. Split at file/hunk boundaries only when complete changed hunks fit; never silently truncate reviewed changes. Process chunks sequentially; the batch passes only when every required chunk passes. Deduplicate findings and validate the combined proposal against the same full captured postimages; conflicting/overlapping chunk proposals require a bounded reconciliation review or pause, not arbitrary precedence. Over-budget indivisible changes pause for explicit adjustment/waiver.
5. Metadata/sensitive-path checks precede outbound review. Use best-effort secret-shape detection and disclose that it is not a guarantee. Sensitive/external/unsupported-snapshot cases pause before sending content. Let the user explicitly authorize the stated provider/content scope, adjust limits, or waive the case. Binary/non-text is visibly not reviewed, not accepted. Do not persist sensitive bodies before authorization.
6. Recheck file hashes before feedback, human decisions, and case closure. If an editor, formatter, shell, or another session changed a tracked file, invalidate the snapshot/proposal and refresh or pause; do not overwrite external changes. First version does not discover arbitrary shell/custom-tool mutations elsewhere and must disclose that coverage gap.

### Approval and correction state machine

```text
excluded filename → auto_approved (no model call)

idle → captured → reviewing → model_approved → idle
                    │
                    ├ needs_work → correcting → reviewing
                    │                 │
                    │                 └ disagreement → human_decision
                    ├ fifth failed correction → human_decision
                    └ exhausted failure/coverage limit → paused

human_decision → accept original → user_approved → idle
               → accept proposed → awaiting exact application → user_approved
               → another five cycles → correcting
```

- Await reviewer completion at `turn_end` before the next primary response. Emit one concise custom feedback message with case ID, snapshot, findings, and proposed edits; keep verbose history in expandable UI/state, not repeated context messages. Approved verdicts and filename-based auto-approvals get distinct compact receipts.
- The initial rejected review starts a case at zero corrections. Each subsequent completed edit/write correction batch and its valid re-review consumes one attempt. Read-only investigation/testing, infrastructure retries, stale responses, and proposal application already authorized by the user do not consume attempts. After five failed corrections, arbitrate; accepting a correction on attempt five closes normally. Another-five adds five to the limit without erasing history.
- Register `quality_response` for `disagree` and `request_scope`: require case/revision and bounded rationale; scope requests name additional helper/test targets and are confirmed by the user. Disagreement opens arbitration at the next safe batch boundary, with no intervening main-model rebuttal round. The agent has no approve/disable/waive action.
- While correcting, allow inspection/tests and edits to case targets. Block unrelated in-scope edit/write targets with a useful gate response; excluded filenames remain automatically permitted by the quality gate. While awaiting human input, block further in-scope mutations until resolved. This is a workflow guard, not a security sandbox; do not attempt a shell-command classifier in v1.
- `agent_before_settle` is the final backstop: unresolved work cannot be reported as gate-approved. An attempted finish with unresolved feedback and no correction goes to user arbitration instead of looping unchanged prompts. Use actionable boundary entries/continuations for corrections, and `ctx.abort()` to pause on cancellation/undeliverable UI; returning `continue: false` is not treated as a universal cancellation mechanism. Preserve pending state on aborted/error outcomes rather than auto-restarting.
- Infrastructure attempts: immediate, +2s, +4s, +6s, +8s delays between failures (five total attempts; maximum scheduled waiting 20s plus request time). Cancellation interrupts requests/backoff. An unset provider/model, unavailable configured model, missing authentication, or invalid configuration pauses immediately as a configuration problem without making a model call. Offer the `/quality-model` selection flow; cancellation leaves the case pending. Excluded-only batches still auto-approve without requiring a configured model. Exhaustion offers retry, change reviewer model, or explicit waiver; Escape leaves pending. No silent model fallback.

### User decisions and proposal application

- **Accept original:** close this case as user-approved for the current reviewed hashes, retaining rationale and optional notes. It does not restore an earlier historical version.
- **Accept proposed:** validate the proposal against the still-current snapshot, record the exact target content hashes, and hand the edits to the main agent. It applies them through ordinary permission-checked edit/write tools; the reviewer/extension does not edit the project. The gate closes only when tracked files exactly match the approved proposal. Partial application stays pending; unexpected changes require fresh review/arbitration, never forced overwrite. No second model approval is required; normal correctness tests still apply.
- **Another five cycles:** retain the current code, findings, and optional notes, add five allowed corrections, and continue. Notes are authoritative for this case only.
- Every selection supports optional multiline notes, final confirmation, and cancellation without implicit approval. Revision/case/session guards apply to the entire choice-and-notes flow.

### State, configuration, and observability

- Commands: `/quality [status|on|off|retry|resolve]` and `/quality-model [provider/model]`. Enabled by default in TUI. Turning off an open gate requires human confirmation and records a waiver/disable event rather than manufacturing acceptance. Model changes cancel stale requests and re-review unresolved snapshots without resetting correction counts or implicitly waiving them. Not exposed as model-callable commands; the model cannot waive itself through `quality_response`.
- Store strict global configuration at `~/.pi/agent/extensions/code-quality/config.json`. Provider/model must be explicitly selected and persisted; omit them from built-in defaults. An absent configuration or absent model selection is a visible unconfigured state, not an inferred selection. Reject partial/invalid provider-model pairs; do not overwrite malformed configuration. Keep non-model operational defaults such as timeouts and size limits. Startup reports missing selection without opening an unsolicited picker; the first in-scope review pauses for configuration. Runtime snapshots/proposals use private storage outside the workspace (0700 directories/0600 files, atomic publication, reject symlink storage), keyed by session/case/content hash. Do not write source-bearing runtime data into the repository.
- Persist branch-local case metadata/counters/decisions through custom session entries; save pending capture state before execution so interruption does not silently clear the obligation. Reconstruct from the active branch on resume/reload/fork/tree changes, cancel old requests/UI by generation, and revalidate filesystem hashes. Missing/corrupt referenced state becomes pending/unavailable, not idle. Compaction preserves the gate through separate durable state, not a summary promise.
- Retain full snapshots only for open cases; retain bounded verdict/decision metadata for auditing. Closed-case source blobs may be pruned, but navigating to a historical open case with unavailable blobs must request fresh capture/user resolution. Never prune active references.
- Status/receipt reports: enabled/inactive, checking, correcting N/limit, awaiting user, model-approved, user-approved, auto-approved (excluded filename; not reviewed), unavailable, and explicitly unreviewed paths/reasons. A premature assistant 'done' message may already have streamed before the settlement hook; an unresolved gate must visibly supersede it with pending/blocked status, not pretend it prevented that text from being emitted. Track requests, retries, latency, tokens and cost when supplied by the provider; report unknown usage honestly. Keep pass messages short and failure details expandable. No new Atelier sidebar or notification subsystem in v1.
- Non-TUI modes run no reviewer or interactive gate; clearly expose inactive status. Policy injection may remain available, but it must not claim enforced approval in those modes.

## Steps

- [x] Upgrade root/workspace Pi dependencies to 0.87.1; update the lockfile after approval and fix demonstrated incompatibilities. Run the existing full suite as a migration checkpoint before adding gate behavior.
- [x] Add the new workspace and canonical policy/examples, hardcoded filename exclusions, strict configuration, isolated reviewer, exact proposal validation, and fake-provider tests.
- [x] Implement bounded capture, private snapshot storage, single-open-case state machine, revision checks, and session recovery.
- [x] Wire `before_agent_start`, post-permission `tool_call`, result reconciliation, actionable `turn_end`, `agent_before_settle`, and lifecycle cleanup. Add `quality_response` and user commands.
- [x] Implement terminal diff/rationale arbitration, three decisions with case notes, and exact proposal handoff/verification.
- [x] Register the eighth extension in both package/local-development lists, package manifests/checks, and document operation, privacy, costs, scope gaps, cancellation and recovery.
- [ ] Complete deterministic integration tests and opt-in model calibration; manually verify interactive long-session behavior before enabling broadly.

## Verification

- **Migration:** run the existing `bun run check` against pinned 0.87.1, plus installed-host compatibility tests for permission owner/PR worker and Atelier focus/layout. Tests may create fixtures during implementation; none run/install as part of this planning phase.
- **Verdicts/proposals:** fake responses for pass, actionable rejection, multiple/no tool calls, invalid JSON, contradictory fields, out-of-scope edits, ambiguous/nonmatching old text, overlap, excessive output, prompt injection in code, and unsupported model/auth. Assert no tools execute in the side model.
- **Model configuration:** absent config/model selection produces no provider call and no implicit observer/main-model fallback; first in-scope review pauses; explicit selection persists and resumes; cancelled selection stays pending; malformed/partial configuration is reported without overwrite; excluded-only batches need no model.
- **Exclusions:** every exact basename and generated-filename pattern, nested paths, case sensitivity, near-miss names, symlink aliasing, mixed batches, excluded-only batches, unavailable model, oversized excluded files, and exclusions during an open case. Assert no body capture/provider calls, no correction-cycle charge, `auto_approved`/`reviewed: false` receipts, intact ordinary permission/error behavior, and no clearing of pending source findings.
- **Capture:** single/multiple edits, two edits to one file, concurrent different files, new files/whole writes, CRLF/BOM, Unicode, unchanged/failed/blocked tools, abort-after-write, external mutation, symlinks, sensitivity checks, config/prose files, chunk budgets and no silently omitted in-scope changes.
- **Gate:** prove with a real Pi synthetic-provider session that the next main request waits for the batch verdict; feedback reaches it once; initial rejection + five failed corrections opens arbitration; earlier explicit disagreement does so immediately; passing fifth correction succeeds; another-five preserves count/history; read/tests do not spend cycles; unresolved finalization cannot silently pass.
- **Failure/recovery:** fake timers assert exactly five request attempts and 2/4/6/8-second gaps. Test cancellation during request/backoff/UI, all failure/waiver paths, hash changes before decision/application, missing persisted state, compaction, reload/resume/fork/tree navigation, and no cross-session delivery.
- **User arbitration:** all three choices and optional notes, cancelled notes, narrow/wide layouts, long diffs, theme/focus with Atelier, exact user-approved proposal application, partial/deviating application, preservation of permission checks, case-only note scope, inactive non-TUI mode, and package load without side effects.
- **Calibration:** preserve the user's 20 choices as preference fixtures (not a rule that every unchosen equivalent is a violation). Include the TUnit API-discovery comment, legitimate workaround rationale, local variables vs helpers, explicit assertions, scenario fixtures, unit names, public fields, test-enforced requirements, and purpose-aware document exceptions. Opt-in live eval with the configured model records false positives/misses and example results; do not make network model judgments a flaky default unit test.
- **Manual smoke:** short approved/rejected edits, lock/generated-file auto-approvals, mixed excluded/source batches, immediate disagreement, five failures, provider outage, external edit during review, approved proposal, pause/resume, and a multi-hour session spanning compaction. Inspect gate receipts and actual produced code, not just the model's claim of compliance.

## Calibration record

These are preference examples, not automatic rejection rules for every unchosen variant. Store representative code pairs in the extension's calibration fixtures; retain this table as the source of the expected direction.

| # | Situation | User preference |
|---|---|---|
| 1 | One-off retry calculation | Named local value |
| 2 | Authorization alternatives | Name each alternative locally |
| 3 | Collection pipeline | Extract predicate, keep pipeline visible |
| 4 | Two clear side effects | Keep both calls visible |
| 5 | Short test structure | Descriptive locals, no section comments |
| 6 | Expired-invitation fixture | Scenario-specific fixture |
| 7 | One-off mock setup | Parameterized `inventoryWithStock(0)` helper |
| 8 | Repeated assertions | Repeat explicit assertions |
| 9 | Retention duration | Policy constant alone, no provider backstory |
| 10 | Charge retry invariant | Name the key shared across attempts |
| 11 | Regex format validation | Named validation predicate |
| 12 | Ignore already-absent file | `removeFileIfPresent` operation contract |
| 13 | Deadlock-preventing sort | Name global lock ordering |
| 14 | Performance requirement | Protect with an executable test; use appropriate benchmark for latency |
| 15 | Public range contract | Precise inclusive/exclusive fields, not redundant API prose |
| 16 | Seconds to milliseconds | Unit-bearing local names |
| 17 | Retry regression test | Explicitly named attempts and assertions |
| 18 | Alternative input modes | Separate entry points or discriminated union; normalize before shared behavior |
| 19 | Parameter-heavy arithmetic | Named intermediates inline |
| 20 | Nearby handler cleanup | Extract meaningful validation/delivery steps |

Earlier examples also established: delete the TUnit API-discovery comment; accept concise verified workaround rationale/removal condition with a regression test; prefer a named local for a one-off rule, but extract a cohesive multi-step recipient collection operation.

## Arbitration UI comparison (requested by user; terminal selected)

### Selected implementation: in Pi's terminal

Show a durable, expandable transcript card with files/revision, findings, proposed diff, and agent objection; a focused decision panel keeps the thread scrollable. Use built-in diff rendering and Editor/SelectList rather than a second TUI renderer. Selection opens optional multiline notes and explicit confirmation. No implicit choice on Escape; leave the gate pending and pause work.

```text
Code quality · human decision · 5/5 corrections
src/invoices.ts   current revision 7b9…

Reviewer: Comment narrates the condition; name the predicate instead.
Agent:    Prefers keeping the two comparisons inline here.

 CURRENT                         PROPOSED
 // Check whether overdue        const isOverdue = ...;
 if (balance > 0 && due < now)    if (isOverdue)

 [1 Accept original] [2 Accept proposed] [3 Another five cycles]
 Notes (optional): ___________________________________________
```

Narrow terminals use a unified diff rather than squeezed columns. Benefits: no browser/process/server lifecycle, works where the agent already runs, easy cancellation. Costs: less comfortable multi-file browsing and large diffs; code must remain readable/scrollable and not be truncated without disclosure.

### Browser comparison (not part of this implementation)

A loopback-only review page with a file list, side-by-side/unified diff, separate reviewer/agent rationale, a notes field, and the exact same three decisions. On submission Pi resumes the same pending case only if session/case/revision still match; close/disconnect leaves it pending.

```text
┌ Files ─────────┬ Current code │ Proposed code ─────────────┐
│ invoices.ts   │              │                            │
│ tests.ts      │              │                            │
├───────────────┴───────────────────────────────────────────┤
│ Reviewer rationale        │ Agent disagreement            │
│ Notes: _________________________________________________ │
│ Accept original     Accept proposed     Another 5 cycles  │
└───────────────────────────────────────────────────────────┘
```

Benefits: better multi-file navigation and roomy comparisons. Costs: browser launch, authenticated loopback decision endpoint, stale-page protection, cancellation/cleanup and additional tests. Existing Plannotator integration already displays static diffs and notes, but its public approve/annotate/dismiss contract does not directly provide these three named decisions; do not quietly equate dismissal with acceptance or fork/patch its UI without an explicit decision. A hybrid can show the diff in the browser and keep the three choices/notes in Pi, but requires moving between interfaces.

## Boundaries and risks

- This enforces a coding-style workflow, not a security boundary or correctness proof. Post-write review means unapproved code can already exist on disk; ordinary tests and PR review remain necessary.
- Known generated/lock filenames are intentionally auto-approved without review. This is a style-scope exemption, not proof of correct generated output, dependency safety, or authorization to edit those files.
- Initial hooks cover explicit edit/write tools, not arbitrary shell/custom tools or independent subagents. Detect changes to already tracked files when rechecking, but do not claim full-workspace coverage.
- A local isolated reviewer cannot prove repository-wide facts or benchmark requirements from a bounded diff. Restrict blocking feedback to concrete, actionable policy violations; let uncertainty pass without speculative churn, and let the user adjudicate disagreements.
- Reviewer proposals are not guaranteed behavior-preserving by schema validation. Exact matching protects application identity, not semantics; the main agent and normal verification still own correctness.
- Private snapshot storage and reviewer requests contain source. Authorization to edit a path is not blanket authorization to send its contents to a different provider. Disclose the configured destination and enforce sensitive/external-content pauses.
- Pi's file mutation queue only coordinates cooperating tools inside a process. Hash checks catch observed external changes, not every possible race with outside editors; never force stale proposals onto changed files.
- The dependency migration is broader than the gate. Preserve the user's existing observer, permission, review, and Atelier behavior through a separate tested milestone rather than bundling speculative cleanup.
