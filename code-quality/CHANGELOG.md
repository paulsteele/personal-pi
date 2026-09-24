# Changelog

## 1.4.0 — 2026-09-24

- Add an isolated post-edit human-readability gate with shared enforced preferences, an explicitly configured reviewer, and exact proposed edits. Exclude formatting, lint, unused-symbol cleanup, correctness, and coverage checks from the review policy.
- Group same-file hunks within the input budget and preserve changed/visible ranges without adding the task or main conversation to reviewer context.
- Let corrections and bounded disagreements share five response-and-review rounds before operator arbitration; retain pending cases across retry, reload, and session navigation.
- Offer original/proposed/five-more-rounds decisions. Enter submits directly; `n` opens optional case notes, whose submission resolves without another confirmation.
- Show compact checking/approval/rejection logs and publish session-scoped quality status and per-call outcomes for Atelier. Keep full feedback expandable and model-facing.
- Auto-approve known generated/lock filenames without model calls; distinguish those exclusions, user approval, waivers, and unavailable review.
- Target Pi 0.87.x with 0.87.1 development dependencies. Formal live-model calibration and full long-session smoke verification remain outstanding; source-bearing runtime snapshots currently have no automatic pruning.
