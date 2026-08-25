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
- Restored rich inline permission prompts with aligned request facts, warning-yellow command/path
  highlights, bounded evidence and edit previews, and `Ctrl+O` expansion while retaining one-press
  one-shot decisions.

