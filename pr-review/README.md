# PR review harness

A code-owned review pipeline with versioned Markdown methodology, private generated repository context, isolated reviewers, independent verification, and Plannotator feedback.

## Commands

- `/pr setup` — create **or regenerate** the current repository's context. Inspect/import the existing repo-root `.claude/skills/pr/SKILL.md` as data, answer unresolved questions, inspect/edit the generated profile, then approve activation. Cancelling preserves the old profile.
- `/pr model` — choose an independent configured model and reasoning level. Main-session model changes do not change this setting.
- `/pr` — review staged/unstaged/non-ignored new files as final working-tree content; use the latest commit only when genuinely clean.
- `/pr --commits N` — last N first-parent commits plus local changes.
- `/pr --base REF` — merge-base through the working tree.
- Add `--committed-only` to an explicit commit/base scope to use HEAD.

For local development in another checkout, start Pi there with `pi -e /absolute/path/to/pi-extensions/pr-review/index.ts`; this loads the existing local entry without installing a package. This repository's development settings load it automatically here after `/reload`. Global release deployment is a separate action, not performed by this feature.

Setup is complete only after you approve the generated profile and see its saved-path confirmation. Choosing a model saves preferences but does not by itself create repository review context. If setup stops, its error remains in the transcript; rerun `/pr setup` to finish it.

Commands show a separate cancellable spinner for each work phase, including elapsed time and worker activity. Model selection, interview questions, and profile approval appear between work phases, never underneath a spinner. Use the displayed cancel key (normally Esc) to stop a running phase. `--base` requires an explicit reference, for example `/pr --base main`.

`pr_review` exposes the same pipeline to the main agent. Interactive Pi TUI and project trust are required. There is no implicit setup, automatic refresh, separate profile command, or hosted-PR fetching. Existing `/skill:pr` remains unchanged.

## Fixed rules versus generated context

All shared methodology, personal-global rules, baseline focus text, and stage instructions live in `prompts/` **in this repository**. They are loaded afresh per invocation. Update these files to evolve review behavior across projects.

Generated context is subordinate data: repository summary, document references, supplemental baseline focus, specialists, path/added-line/removed-line triggers, exclusions, and source fingerprints. It cannot disable stages or the four fixed baselines: Security, Performance, Correctness, and Style/Conventions. There is no hand-maintained per-repository fixed layer.

When a declared convention/architecture/manifest source changes or disappears, review stops and directs you to rerun `/pr setup`. Ordinary commits and compatible shared-prompt edits do not automatically invalidate profiles. Worktrees sharing the same canonical Git common directory share a profile; separate clones do not.

## Private storage

Everything created by the harness is under `getAgentDir()/extensions/pr-review/` (normally `~/.pi/agent/extensions/pr-review/`):

- `config.json`: independent model/reasoning and runtime limits.
- `repos/<repo-id>/profile.json`: approved generated context.
- `repos/<repo-id>/reports/<run-id>.json`: structured report, rendered Markdown, verification ledger, and browser feedback. Default retention: 20 runs per repository.
- `viewer-sessions/`: temporary isolated Plannotator data, removed when the viewer closes. Owned abandoned directories are cleaned on a later invocation after their process is gone.

The root is ignored by Git and files use private permissions. An existing runtime ignore file may contain only `*` plus blank lines/comments; rules that re-include private files are refused. Checkout-local storage and Git-tracked runtime files are refused. Publication uses an exclusive lock and atomic compare-and-swap; a stale lock is reported rather than guessed away. No project config, source snapshots, worker transcripts, provider credentials, or custom generated commands are written. Reports can contain code excerpts; treat them as sensitive despite best-effort secret redaction.

Defaults are four concurrent workers and five minutes per worker, with additional turn/job/context limits. To adjust limits, edit the private `config.json` after model selection; invalid/unknown settings are refused rather than silently replaced. Model calls can incur costs through your configured provider.

## Browser workflow

Requires an **already-loaded Plannotator Pi extension**, currently compatibility-gated to `0.27.12`. The harness never installs, updates, forks, vendors, or patches Plannotator.

The existing server and HTML renderer run in a small isolated UI helper—not another Pi agent. It receives only the captured diff and verified annotations. Ask AI and sharing are disabled for this helper, and its data is confined to private Pi storage. Your ordinary Plannotator settings and other open reviews are untouched.

The browser is a snapshot-only diff view with surrounding context, not a live repository browser: no branch switching, staging, live file expansion, or fallback to a different checkout. Verified findings appear as existing comments, including original severity, reviewer labels, and evidence. Plannotator can show a generic “Uncommitted changes” mode label without live Git metadata; the summary comment and saved report contain the authoritative requested scope, baseline, HEAD, and captured fingerprint.

- **Send Feedback** requests fixes for the verified finding comments in the submitted payload. Remove findings you do not want fixed. Merely hiding/filtering comments is not selection.
- **Questions, objections, edited findings, and reply threads** return to the main agent for discussion; they are not blanket approval of the original suggestion.
- **Approve/LGTM or Close** requests no automatic fixes. Approval notes may still be discussed.

Every returned command/tool report explicitly states its browser outcome and authorized IDs—even when none are authorized or the viewer fails. Approval notes are handed back for discussion, and truncated output retains a full-report locator. No second Pi selection screen is shown. Source drift, malformed/stale IDs, a failed viewer, or incomplete seeding cannot authorize fixes. The main agent reads the full report/feedback before implementing requested changes under its normal permissions and test workflow. This harness does not apply patches or run project tests itself.

## Review guarantees and limits

Code enforces stage order, mandatory baseline presence, worker tools, budgets, result schemas, evidence matching, verification accounting, and browser-to-finding identity. Review workers only read/search/list captured repository content and submit structured results. They have no shell, write, network, or arbitrary extension tools.

Source capture refuses active clean/process filters selected by current or staged Git attributes, rather than executing repository conversion commands. Configured but unused filters are allowed. Index flags such as assume-unchanged/skip-worktree cause an explicit refusal; the harness never clears your flags. A shallow checkout with unavailable first-parent history is not mistaken for an initial commit.

Committed blobs use a byte-bounded LRU (budget: the larger of `maxDiffBytes` and `maxFileBytes`), with serialized cache misses and in-flight deduplication. Eviction reloads immutable Git objects, never live working-tree content. Captured working-tree buffers remain separate. Reviewer and verifier inputs are packed by actual JSON byte size; verification also retains the ten-candidate limit. Verifiers receive captured mode/rename metadata and can page complete patches with `read_change`.

Whether a finding is actually true and whether issues were missed remain model judgments. Source capture checks for concurrent changes but is not an atomic filesystem snapshot. Provider cancellation is cooperative; late output is rejected. Usage/cost reflects what providers reported.

Binary, non-UTF8, symlink, submodule, oversized, or unavailable content is explicitly listed. A single file diff too large for a reviewer context is marked incomplete rather than silently truncated. Pure renames retain their old/new names; edited renames can appear as deletion/addition pairs. No failed or skipped work is called clean.

## Development and verification

```sh
bun run --cwd pr-review check
bun run test:integration
```

The normal tests use synthetic repositories and fake providers. The separate compatibility probe uses existing installations supplied explicitly, never downloads:

```sh
PR_REVIEW_TEST_PI_PACKAGE=/path/to/installed/pi-coding-agent \
PR_REVIEW_TEST_PLANNOTATOR_PACKAGE=/path/to/installed/pi-extension \
bun run --cwd pr-review test:compat
```

Supply those same environment variables to `bun run --cwd pr-review test:browser` for an explicit human browser smoke test: it opens a synthetic review with two findings, asks you to remove F2 and submit F1, and reports the returned IDs without applying any fixes.

Supply those same environment variables to `bun run --cwd pr-review test` to include the production viewer's synthetic HTTP round-trip. It opens no browser, makes no model calls, uses temporary directories, and never submits feedback to a real user review. A real browser smoke test and any model-backed review must be performed separately and deliberately.
