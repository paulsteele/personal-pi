# Changelog

## Unreleased

## 1.0.5 — 2026-09-03

- Route unresolved path-bearing shell expansions through the auto classifier as an explicit risk marker, including when generic Bash policy allows the command; retain direct human review when auto mode is off and preserve stronger deterministic guards.
- Add `Allow directory for session` to external-directory approval prompts; grant the canonical directory and its descendants in memory until session end without changing global policy or broadening to a parent.
- Retry malformed classifier output up to twice with an explicit tool-call repair instruction before escalating to human approval, while retaining the original operation deadline and fail-closed behavior.
- Simplify the armed auto-mode footer status to `⏵⏵ auto`; detailed allow and human-ask counts remain available through auto-mode events and Atelier Activity.

## 1.0.3 — 2026-09-01

- Closed Bash compound-command safety gaps by projecting `for`/`select` iterables, filesystem test operands, and statically resolvable local scalar bindings through control-flow scopes.
- Preserved whole compound units while enumerating executable descendants, so deterministic command guards and explicit Bash policy denies cannot be hidden inside loops, conditions, case arms, groups, or function bodies.
- Added a fail-closed human guard for path-bearing shell operands whose expansions remain unresolved, before classifier review.

## 1.0.2 — 2026-08-31

- In human review prompts, color Tree-sitter Bash command units covered by deterministic `allow` policy with the policy color, while leaving unresolved units and the reviewed action warning-colored. This is presentation-only and does not change classifier inputs or decisions.

## 1.0.1 — 2026-08-28

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

