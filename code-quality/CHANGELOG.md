# Changelog

## 1.5.5 — 2026-10-02

- Test against Pi 1.0.0 with wildcard host-package peer ranges. Keep `quality_response` model-only so correction-scope requests and disagreements stay directly visible to the main model.

## 1.5.4 — 2026-09-30

- Prioritize source and project markers before discovery limits, include initialized Git submodules, and use ancestor lookup for large workspace-root sets.
- Preserve checklist selections in Advanced setup, disclose pending configuration changes before validation, and retain C# project choices and relative-path overrides.
- Treat queued events under removed directories and symlink replacements as deletions, closing stale document overlays without reading symlink targets.
- Clarify shared-watcher recovery: close all attached Pi sessions before reopening any. Add regression coverage for multi-client recovery, discovery limits, setup consent, and watcher races.
- Show LSP and readability stages in the main transcript, updating each line with a pass/fail marker and preserving results across reloads and branch navigation.
- Show reviewer rejection rationale and file/line findings without expanding feedback; keep full case details and proposed edits expandable.

## 1.5.3 — 2026-09-29

- Fix shared LSP broker crashes from file-handle exhaustion in large macOS workspaces by using native recursive watching instead of per-file watchers. Keep dependency changes observable without excluding restored packages.
- Report workspace watcher failures to attached clients and refuse checks until the broker is recreated, rather than crashing or reporting unchecked results. Wait for portable watcher initialization before serving checks.
- Add watcher and broker regression tests for startup failures, runtime errors, event normalization, exclusions, and shutdown. Validate Roslyn setup against a large C# solution with restored NuGet dependencies.

## 1.5.2 — 2026-09-29

- Fix LSP source discovery stopping inside dependency trees before reaching application source. Use sorted Git-listed files with standard ignore rules, and breadth-first traversal when Git discovery is unavailable.
- Report scan-limit exhaustion separately from a workspace with no matching source, including the workspace and expected extensions in validation errors.
- Add regression tests for large dependency trees, nested workspaces, ignored and deleted files, symlinks, cancellation, and validation after a partial scan.

## 1.5.1 — 2026-09-29

- Fix LSP setup failing on existing shared installations: reuse receipt-verified servers and discover unreceipted executables, including .NET tools installed directly in the version/platform directory. Preserve existing installations and require per-project validation and approval.
- Recheck for completed installations after approval so concurrent setup can reuse them instead of reporting a destination conflict.

## 1.5.0 — 2026-09-29

- Add project-configured LSP diagnostics before readability review. All reported severities use the existing correction rounds and operator arbitration; warnings and hints are not filtered out.
- Add guided private setup, pinned server installations with approval, doctor/status/restart controls, and worktree-shared profiles for C#, TypeScript/JavaScript, Python, Rust, and Go.
- Share warm LSP processes through a local broker, retaining per-Pi cases and shutting down after the last client disconnects. Show server names, lifecycle state, and sharing counts in Atelier's quality row.
- Add real-server compatibility probes, packed-loader checks, and regression tests for stale diagnostics, cancellation, restart, creator crashes, and no-proposal arbitration. Real-server validation currently covers macOS arm64.
- Simplify setup to one language checklist with automatic executable/root/name selection and a single validate-and-enable confirmation. Keep custom overrides behind Advanced and suppress routine operational messages in the transcript.
- Correlate LiteLLM reviewer calls in a separate per-Pi quality session without changing main-model or routing/cache identities.
- Preserve quality check/rejection counters across session navigation and clarify explicit conditional-block requirements in the readability policy.

## 1.4.2 — 2026-09-28

- Notify the desktop when quality dialogs require a human decision: arbitration, file-review authorization, failure recovery, correction-scope approval, reviewer selection, and waivers. Clear matching notices when dialogs end or sessions retire; keep ordinary agent-handled rejections silent and source data out of notifications.

## 1.4.1 — 2026-09-25

- Give invalid reviewer submissions one immediate repair attempt with explicit finding/edit ranges and bounded validation feedback, rather than repeating identical requests.
- Keep the five-provider-failure retry budget separate from submission repair and readability rounds; preserve repair feedback across transport retries and stop when complete repair context cannot fit.

## 1.4.0 — 2026-09-24

- Add an isolated post-edit human-readability gate with shared enforced preferences, an explicitly configured reviewer, and exact proposed edits. Exclude formatting, lint, unused-symbol cleanup, correctness, and coverage checks from the review policy.
- Group same-file hunks within the input budget and preserve changed/visible ranges without adding the task or main conversation to reviewer context.
- Let corrections and bounded disagreements share five response-and-review rounds before operator arbitration; retain pending cases across retry, reload, and session navigation.
- Offer original/proposed/five-more-rounds decisions. Enter submits directly; `n` opens optional case notes, whose submission resolves without another confirmation.
- Show compact checking/approval/rejection logs and publish session-scoped quality status and per-call outcomes for Atelier. Keep full feedback expandable and model-facing.
- Auto-approve known generated/lock filenames without model calls; distinguish those exclusions, user approval, waivers, and unavailable review.
- Target Pi 0.87.x with 0.87.1 development dependencies. Formal live-model calibration and full long-session smoke verification remain outstanding; source-bearing runtime snapshots currently have no automatic pruning.
