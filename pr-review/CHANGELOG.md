# Changelog

## Unreleased

- Preserve explicit no-fix outcomes and approval-note discussion in command/tool results; keep report locators after display truncation.
- Harden capture against active Git filters, hidden index flags, symlinked ancestors, and unavailable shallow history; support directory-to-file replacements.
- Bound blob-cache residency and fingerprint reads; stop searches at the match cap and pack reviewer/verifier inputs incrementally by bytes.
- Expose captured diffs and metadata to verifiers; make retention cleanup idempotent and reject unsafe ignore-file negations.
- Resolve development executables through package resolution for hoisted/local installs and prevent browser launches after cancellation.

- Fix command UI lifecycle: only non-interactive work is wrapped in a spinner; setup/interview/approval dialogs no longer replace a still-running outer spinner.
- Show live phase activity and elapsed time, preserve cancellation, and keep command errors in the transcript.
- Reject a missing `--base` reference before starting work and explain when only model selection—not repository setup—has completed.
- Add command-level, dialog-ordering, fast-failure, spinner cleanup, and cancellation regression tests.

## 1.0.7

- Add code-owned PR review orchestration with versioned methodology and personal-global rules.
- Add explicit setup/regeneration, independent model selection, private worktree-shared profiles, and blocking freshness checks.
- Add immutable Git-backed source views, bounded read-only reviewers, independent evidence verification, and structured reporting.
- Add a guarded adapter to the already-installed Plannotator review UI, browser-authorized fix handoff, and private bounded report history.
