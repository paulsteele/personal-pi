# Changelog

## 26.3.1-local.1 — unreleased

- Established a source-owned personal fork from `pi-permission-system-v26.3.1`.
- Imported the hardened deterministic tool-call guard work as the migration baseline.
- Recorded rollback material, previous patch checksum, and pre-cutover green baselines in `FORK.md`.
- Integrated auto review, single-selection one-shot human decisions, branch-local classifier notes,
  fixed global configuration, bounded redacted review logging, and correlated decision events.
- Retired the old npm/patch and loose-auto runtime artifacts to the rollback snapshot after isolated
  fork and Atelier checks passed.
- Enforced explicit skill invocation and skill-directory reads, matched path policies against
  canonical aliases, restored classifier request/environment context, propagated cancellation,
  protected invalid configuration from overwrite, and removed raw decision text from review logs.
- Restored rich permission request facts with warning-highlighted command/path evidence and bounded
  edit previews.
- Narrowed classifier authority to allow-or-require-human and changed every positive deterministic
  safety match to fresh human approval; explicit policy deny remains terminal and headless escalation
  remains fail-closed.
- Persisted bounded permission requests and correlated human outcomes as TUI-only transcript entries,
  leaving a compact decision-control panel and the full conversation scrollable. Shared Atelier's
  `󰚩` classifier, `󰀄` human, and `󰒃` security/policy provenance glyphs and replaced auto-deny
  accounting with classifier allow/human-asked counts.

