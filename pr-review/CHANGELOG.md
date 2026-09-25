# Changelog

## 1.4.1 — 2026-09-25

- Search ordinary snapshot files locally without prompting for files that return no matches. Authorize matching snippets before disclosure and report denied/protected files as skipped coverage.
- Retain only delivered matching files as continuing search dependencies, and commit source dependencies only after the outer tool result is accepted. Preserve live-policy and cancellation checks across scanning and disclosure.

## 1.4.0 — 2026-09-24

- Migrate worker termination to Pi 0.87.1's `finishTurn` hook while preserving submission, compaction, stall detection, and permission exits.
- Update synthetic provider tests for transcript-carried tool declarations and UI fixtures for the current overlay contract; target Pi 0.87.x.

## 1.3.1

- Skip unchanged snapshot metadata before yielding, so large repositories no longer spend an event-loop turn (and possible full UI redraw) per tracked file. Retain cooperative cancellation for actual, excluded, and denied changes.

## 1.2.0

- Validate outgoing source sets under one stable permission revision, yield during bulk checks, and recheck at provider dispatch after authentication/preflight waits. Preserve the same safeguards for compaction and publication.
- Commit coverage and checkpoint bookkeeping only after the outer tool guard accepts the result; keep context preparation/residency within the configured worker concurrency.
- Yield and restore setup's phase spinner around human permissions, keep output recovery inspectable, and retry permission-blocked optional stages explicitly rather than permanently skipping them.
- Correct persisted and returned fix authorization after final source drift, preserving browser feedback and the report locator. Distinguish automatic checks, slot waits, and actual human approvals in task status.

- Minimize PR status before permission controls appear, including main-agent prompts during background reviews. Prevent reopening or deferred dashboard mounting from obscuring permission input, retain explicit `/pr status` reopening afterward, and cover real installed-Pi overlay/input behavior.

- Remove Plannotator version restrictions from discovery and the isolated viewer host. Accept any loaded release while retaining package identity, required assets/server API, isolation, and browser-response validation.

- Require the loaded Permission System for source-consuming reviews/setup and route capture, worker tools, inline source and derived-result transfers through the normal live policy/classifier/human pipeline. Keep PR read-only and retain its current worker engine; no generic runtime or bundled permission copy.
- Isolate turn-local classifier reuse, queue parent approvals, expose permission wait/retry states, and recheck report/viewer/parent output. Deferred excluded source retains snapshot identity; denied searches and required context are explicit, and source/body caches never grant access.

- Add Human Readability as a fifth mandatory whole-change baseline, covering high-level intent, accurate names, intent-revealing functions rather than temporal narration, and reviewable diff hunks. Require concrete, independently verified comprehension problems rather than cosmetic preferences; support optional profile supplements without requiring a new baseline entry.

## 1.1.2

- Register the exact saved report with Pi Permission System for current-session external-directory access before command/tool handoff. Never grant the reports directory or persist permission configuration; cancelled, retired, or unsaved results grant nothing.
- Reserve serialized assignment and JSON framing in the overall inline budget before packing shared documents; retain smaller evidence when shared documents do not fit and avoid empty-prefix overhead for near-limit assignments.
- Reuse deterministic shared background/document prefixes while keeping reviewer assignments ahead of diffs, including paged tasks and compaction. Remove duplicated reading lists and architecture focus without narrowing review scope.
- Preserve cache token counts, cost components, and first/continuation/compaction usage aggregates through task diagnostics, reports, and parent-tool usage; label older missing metrics unavailable. Give logical workers stable, separate routing IDs without changing retention defaults.
- Pack verification against model context capacity; independently verify exact duplicate claims once with unioned guidance and map verdicts back to every original ID/reviewer. Skip semantic consolidation only when the existing location rules forbid additional merges.

## 1.1.1

- Validate Plannotator `0.27.14` alongside `0.27.12`, share the production version gate between discovery and the viewer host, and report installed/supported versions on mismatch. Allow the opt-in synthetic compatibility probe to test candidate releases before enabling them.

## 1.1.0

- Frame the review dashboard with a theme-aware background, accent border, section dividers, status icons, and full-row selection highlighting. Cap its width at 120 columns and budget scrolling around the frame/footer on smaller terminals.

- Keep command-launched reviews responsive: release the idle command loop while reviews run, route phase progress and the viewer URL into live status, and preserve awaited tool results and session/cancellation ownership. Status/retry/cancel no longer queue behind browser feedback.

- Fix authorized review findings: require complete candidate-body delivery; normalize approved specialist reading; use collision-checked hashed task IDs; distinguish successful grouping/search progress from loops; and pack inline context in linear time.
- Index changed-line anchors during diff generation, use bounded indexed line/character reads with cancellation, and stream viewer patches to an owned aggregate loaded only by the isolated helper.
- Guard and synchronously invalidate throttled tool updates on operation cancellation/session retirement.

- Simplify setup: approved profiles remain reusable after repository changes; remove the source-fingerprint gate and automatic regeneration pressure.
- Replace the large JSON approval modal with a private editable draft and `/pr setup approve`; add model-free `/pr setup edit` and explicit `/pr setup regenerate`.
- Coalesce actual host UI updates, cache details, and stream specialist trigger matching rather than synchronously rereading/reparsing patches.
- Supply captured context directly, count normal reads automatically, make checkpoints optional, and add an explicit blocker tool. Failed optional stages use deterministic fallbacks; one blocked reviewer no longer stops unrelated workers.
- Persist a small sanitized live task journal and clean up setup snapshots so restarts do not erase all diagnostic evidence.

- Replace reviewer × diff-batch fan-out with four whole-change baselines, an architecture/integration pass, and specialists routed to validated related-file areas.
- Remove work-total quotas and size-based capture omissions; add authoritative coverage checkpoints, context compaction/continuation, and explicit Retry/Cancel recovery.
- Capture large source/diffs in private run-scoped temporary backing files with indexed paging and cancellation-safe exact diff workers; clean up owned temporary data.
- Add a shared terminal task dashboard for command/tool reviews: stable queue, full scope/usage/activity details, hide/reopen, and status/retry/cancel controls.
- Verify related candidates across files without total batch caps, and keep unverified architecture advisories separate from fix-authorizing findings.
- Normalize legacy config without rewriting it on read; preserve model/concurrency while retiring coverage-limiting settings. Persist task metrics and retain old-report compatibility.

## 1.0.8

- Preserve explicit no-fix outcomes and approval-note discussion in command/tool results; keep report locators after display truncation.
- Harden capture against active Git filters, hidden index flags, symlinked ancestors, and unavailable shallow history; support directory-to-file replacements.
- Bound blob-cache residency and fingerprint reads; stop searches at the match cap and pack reviewer/verifier inputs incrementally by bytes.
- Expose captured diffs and metadata to verifiers; make retention cleanup idempotent and reject unsafe ignore-file negations.
- Resolve development executables through package resolution for hoisted/local installs and prevent browser launches after cancellation.

- Fix command UI lifecycle: only non-interactive work is wrapped in a spinner; setup/interview/approval dialogs no longer replace a still-running outer spinner.
- Show live phase activity and elapsed time, preserve cancellation, and keep command errors in the transcript.
- Reject a missing `--base` reference before starting work and explain when only model selection—not repository setup—has completed.
- Add command-level, dialog-ordering, fast-failure, spinner cleanup, and cancellation regression tests.

- Add code-owned PR review orchestration with versioned methodology and personal-global rules.
- Add explicit setup/regeneration, independent model selection, private worktree-shared profiles, and blocking freshness checks.
- Add immutable Git-backed source views, bounded read-only reviewers, independent evidence verification, and structured reporting.
- Add a guarded adapter to the already-installed Plannotator review UI, browser-authorized fix handoff, and private bounded report history.
