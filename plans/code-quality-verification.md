# Code quality gate verification

## Completed

- Root and workspace manifests/lockfile upgraded to Pi 0.87.1 development packages and 0.87.x peer ranges.
- Verified actual root package versions after replacing stale root/workspace dependency trees; all four Pi packages resolve to 0.87.1.
- `bun run check` passed against the resolved 0.87.1 dependencies after implementation.
- Quality workspace: 71 deterministic tests passing, covering configuration, exclusions, strict verdicts/proposals, same-file grouping, isolated readability scope, retry schedule, capture/state, five-round corrections/disagreements, quick operator decisions, compact logs, and representative recovery paths.
- Five real Pi synthetic-provider integration tests passing: batch-boundary waiting, five-round finalization/arbitration, disagreement resolution without operator interruption, five unsuccessful disagreements, and permission-denied writes never entering review.
- Atelier: 219 tests passing, including quality-header placement, inline badges, palette matching, and event correlation/lifecycle behavior.
- Existing installed-host permission owner, PR worker, and UI focus compatibility checks passed (browser-specific checks not configured).
- `git diff --check` passed.
- Opt-in live calibration command implemented: `bun run --cwd code-quality calibrate`. Twelve representative fixtures, including scope regressions; full preference directions remain in the policy/examples and original interview table.
- Live use during this development session exercised approvals, rejections, user arbitration, reloads, and UI iteration. False-positive feedback led to the readability-only scope and grouped same-file context.

## Pending before broad rollout

- Formal execution of the opt-in calibration suite and a measured false-positive comparison remain outstanding. Live development feedback is not a substitute for that evaluation.
- Expand calibration fixtures as needed; the twelve current cases are not full coverage of the 20-example interview.
- Human terminal smoke: scroll current/proposed diff, all three decisions with multiline notes, Escape, narrow width, theme/focus alongside Atelier.
- Multi-hour interactive run spanning real compaction/reload/resume. Automated controller tests cover representative recovery but do not substitute for this live check.
- Runtime snapshot records currently remain on disk; no automatic retention pruning is implemented. Documentation discloses this. They are private and content-addressed, but repeated reviews will consume disk space.
- The release does not install global reviewer configuration or modify AGENTS.md. The extension is registered in the package; `/reload` or restart loads it. First in-scope edit pauses for reviewer selection if unconfigured.

Step 7 of the approved checklist remains open because live calibration and manual long-session verification have not been completed.
