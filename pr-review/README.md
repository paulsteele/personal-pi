# PR review harness

A code-owned review pipeline with versioned Markdown methodology, private generated repository context, isolated reviewers, independent verification, and Plannotator feedback.

## Commands

- `/pr setup` — first-time setup writes a private profile draft and prints its path. If already configured, returns immediately without model calls.
- `/pr setup edit` — create/open an editable draft of the existing profile, without model calls.
- `/pr setup approve` — validate and activate the draft you inspected in your editor. No giant JSON dialog or source recapture.
- `/pr setup regenerate` — explicitly request newly generated context. The active profile remains unchanged until approval.
- `/pr model` — choose an independent configured model and reasoning level. Main-session model changes do not change this setting.
- `/pr status` — reopen the live task dashboard, or inspect the most recent finished run in this session.
- `/pr retry` — resume blocked review work without repeating completed reviewers.
- `/pr cancel` — cancel the active operation, including while `pr_review` is running.
- `/pr` — start an owned background review of staged/unstaged/non-ignored new files as final working-tree content; use the latest commit only when genuinely clean. Final results are posted after browser feedback.
- `/pr --commits N` — last N first-parent commits plus local changes.
- `/pr --base REF` — merge-base through the working tree.
- Add `--committed-only` to an explicit commit/base scope to use HEAD.

For local development in another checkout, start Pi there with `pi -e /absolute/path/to/pi-extensions/pr-review/index.ts`; this loads the existing local entry without installing a package. This repository's development settings load it automatically here after `/reload`. Global release deployment is a separate action, not performed by this feature.

Setup is complete after `/pr setup approve` activates the saved draft. Edit `profile-draft.json` in your preferred editor; the full path is printed in the transcript. No terminal editor is needed. Choosing a model alone does not activate a profile. Subsequent code, README, manifest, lockfile, or convention changes **do not require setup again**. Old profiles stay compatible; captured current code/docs take precedence over historical profile descriptions.

Host widget/status/overlay updates are coalesced, unchanged summaries are not replaced, and task-detail text is cached. Reviews auto-open a scrollable task dashboard in a filled, accent-bordered panel capped at 120 columns (shrinking to fit narrower terminals). Status icons/colors, a full-row selection highlight, and separate summary/task/details/control sections distinguish it from the underlying transcript. Queued/running/completed/blocked tasks stay visible rather than cycling through one agent's latest activity. Select a task with the navigation keys; Enter switches to full details (scope, model, coverage, usage, recent activity, continuations and retries). **Esc hides the dashboard without cancelling.** Reopen with `/pr status`; use `c` and confirmation or `/pr cancel` to stop. `r` or `/pr retry` resumes blocked work. The compact summary remains available when hidden. Command-launched reviews release Pi's idle command loop immediately, so status/retry/cancel work before Plannotator feedback—not only after it. The agent-invoked `pr_review` tool still waits for its final result. The viewer-ready URL appears in a notification, the live dashboard, and the compact widget when the dashboard is hidden.

Setup and model selection retain their phase spinners and original cancel keys. Approval dialogs are never underneath the review dashboard. `--base` still requires an explicit reference, for example `/pr --base main`.

## Review scope and execution

Each review has four independent **whole-change baselines** plus a whole-change **Architecture / Integration** task. The existing scout proposes coherent related-file areas and optional specialists; validated area assignments route specialists only to relevant scope. Saved always-on specialists remain global. Invalid area plans use an explicit deterministic path fallback without dropping files.

Logical review tasks are **5 + scoped specialist tasks**, not reviewer × diff chunks. Planning, independent verification and optional consolidation are separate stages. Verification packs related candidates across files, up to ten per batch, and creates as many batches as necessary. Each full candidate body is a mandatory delivery resource: it must be supplied inline or completely paged before any verdict is accepted. A candidate ID or its source diff alone is not sufficient. The dashboard distinguishes these logical tasks from harness-initiated model requests, compactions and retries. Provider-internal HTTP retries are not separately observable; usage reflects what the provider reports.

There are **no work-total job, reviewer, turn, token-spend or worker-duration quotas**. The harness supplies complete captured diffs and guidance directly when they fit the model context. Normal `read` and `read_change` calls automatically count as supplied context, including legacy line offsets. Reviewers do not need to manage read receipts or checkpoint keys. Intermediate findings/notes can optionally be saved for long reviews. Context pressure triggers compaction and continuation of the same logical reviewer. Context delivery is not proof that every defect was found; the reviewer still owns the complete assigned scope.

A reviewer can explicitly report a blocker for Retry/Cancel; unrelated workers continue instead of waiting behind a global recovery gate. Optional scout failures fall back to the saved roster and deterministic areas, and optional consolidation failures retain exact grouping. Genuine failures do not silently skip mandatory review work. Unsupported content blocks completion rather than being silently skipped. Explicitly approved profile exclusions remain outside scope. If repair requires changing captured source, cancel and start a new review—retry never mixes live edits into an existing snapshot.

`pr_review` exposes the same pipeline to the main agent. Interactive Pi TUI and project trust are required. There is no implicit setup, automatic refresh, separate profile command, or hosted-PR fetching. Existing `/skill:pr` remains unchanged.

## Fixed rules versus generated context

All shared methodology, personal-global rules, baseline focus text, and stage instructions live in `prompts/` **in this repository**. They are loaded afresh per invocation. Update these files to evolve review behavior across projects.

Generated context is subordinate data: repository summary, document references, supplemental baseline focus, specialists, path/added-line/removed-line triggers, exclusions, and source fingerprints. It cannot disable stages or the four fixed baselines: Security, Performance, Correctness, and Style/Conventions. There is no hand-maintained per-repository fixed layer.

Once approved, a profile remains usable across repository changes. There is no source-fingerprint freshness gate and no automatic regeneration. Missing old document references are reported as context notes while review uses the current change and available guidance. Explicit regeneration is for material context improvements you choose to request—not routine edits. Worktrees sharing the same canonical Git common directory share a profile; separate clones do not.

## Private storage

Everything created by the harness is under `getAgentDir()/extensions/pr-review/` (normally `~/.pi/agent/extensions/pr-review/`):

- `config.json`: independent model/reasoning and runtime limits.
- `repos/<repo-id>/profile.json`: approved reusable context.
- `repos/<repo-id>/profile-draft.json`: human-editable draft; `profile-draft-state.json` records its origin/approval state.
- `repos/<repo-id>/latest-run-<pid>.json`: coalesced live task diagnostics, including last activity/blockers and a short sanitized event tail. Each Pi process owns its own latest-run file, so a restart leaves the old run inspectable. No prompts, source bodies, or model reasoning are stored.
- `repos/<repo-id>/reports/<run-id>.json`: structured report, rendered Markdown, verification ledger, and browser feedback. Default retention: 20 runs per repository.
- `snapshots/`: private run-scoped captured source/diff backing files. These keep large reviews from requiring all source and diff text in RAM. They are removed on completion/cancellation; recognized abandoned runs are cleaned after their owning process has exited.
- `viewer-sessions/`: temporary isolated Plannotator data, removed when the viewer closes. Owned abandoned directories are cleaned on a later invocation after their process is gone.

The root is ignored by Git and files use private permissions. An existing runtime ignore file may contain only `*` plus blank lines/comments; rules that re-include private files are refused. Checkout-local storage and Git-tracked runtime files are refused. Publication uses an exclusive lock and atomic compare-and-swap; a stale lock is reported rather than guessed away. No project config, worker transcripts, provider credentials, or custom generated commands are written. **Captured source can now be written temporarily under the private runtime root**, never the checkout or report/session payload. This replaces the previous in-memory-only capture guarantee. Reports retain compact task metrics/coverage and may contain evidence excerpts; treat both temporary captures and reports as sensitive despite permissions and best-effort report redaction. Model transcripts are not persisted. Only the last five sanitized activity events per task are included in the live diagnostic journal.

The default remains **four concurrent workers**. Schema-version-2 preferences contain model/reasoning, concurrency, report retention, and `requestTimeoutMs` (default five minutes **per provider request**, not per reviewer). A request timeout causes recovery or a pause, never quota-based scope removal. Existing v1 preferences are normalized on read with a visible notice: old job/reviewer/turn/input/file/diff quotas are ignored. Loading does not rewrite config; a later explicit model save writes v2. Invalid/unknown settings are still refused. Full-scope reviews can take longer and incur more cost than capped partial runs; use the task metrics rather than assuming fewer tasks always means lower latency.

## Browser workflow

Requires an **already-loaded Plannotator Pi extension**, currently compatibility-gated to `0.27.12`. The harness never installs, updates, forks, vendors, or patches Plannotator.

The existing server and HTML renderer run in a small isolated UI helper—not another Pi agent. The parent streams the captured diff into a private viewer-owned aggregate with backpressure; only the helper materializes it for the renderer. The helper checks the owning parent and refuses symlinked/non-regular inputs. It receives only the captured diff and verified annotations. Ask AI and sharing are disabled for this helper, and its data is confined to private Pi storage. Your ordinary Plannotator settings and other open reviews are untouched.

The browser is a snapshot-only diff view with surrounding context, not a live repository browser: no branch switching, staging, live file expansion, or fallback to a different checkout. Verified findings appear as existing comments, including original severity, reviewer labels, and evidence. Architecture may also produce clearly labeled **unverified design advisories**. Their quoted locations are checked, but the design judgments do not receive an independent model pass. Advisories are discussion-only general comments with no authorized finding IDs; submitting, editing, or replying to one never authorizes automatic fixes. Plannotator can show a generic “Uncommitted changes” mode label without live Git metadata; the summary comment and saved report contain the authoritative requested scope, baseline, HEAD, and captured fingerprint.

- **Send Feedback** requests fixes for the verified finding comments in the submitted payload. Remove findings you do not want fixed. Merely hiding/filtering comments is not selection.
- **Questions, objections, edited findings, and reply threads** return to the main agent for discussion; they are not blanket approval of the original suggestion.
- **Approve/LGTM or Close** requests no automatic fixes. Approval notes may still be discussed.

Every returned command/tool report explicitly states its browser outcome and authorized IDs—even when none are authorized or the viewer fails. Approval notes are handed back for discussion, and truncated output retains a full-report locator. No second Pi selection screen is shown. Source drift, malformed/stale IDs, a failed viewer, or incomplete seeding cannot authorize fixes. The main agent reads the full report/feedback before implementing requested changes under its normal permissions and test workflow. This harness does not apply patches or run project tests itself.

## Review guarantees and limits

Code enforces stage order, mandatory baseline presence, worker tools, coverage-ledger closure, per-request/schema boundaries, evidence matching, verification accounting, and browser-to-finding identity. Review workers only read/search/list captured repository content and submit structured results. They have no shell, write, network, or arbitrary extension tools.

Source capture refuses active clean/process filters selected by current or staged Git attributes, rather than executing repository conversion commands. Configured but unused filters are allowed. Index flags such as assume-unchanged/skip-worktree cause an explicit refusal; the harness never clears your flags. A shallow checkout with unavailable first-parent history is not mistaken for an initial commit.

Captured working-tree data and immutable Git blobs have private backing files; large exact diffs run off the TUI thread. Cursor and line-offset reads use sparse UTF-8/line indexes and can continue within a long line. Changed-line ranges are computed during off-thread diff generation, so evidence checks do not reread/reparse entire patches. Cache/page capacity controls resource use, not eligibility for review. Reviewer/verifier inputs use actual JSON sizes to decide what to inline versus page, never to drop work. Verification retains the **per-batch** ten-candidate limit and complete mode/rename metadata.

Whether a finding is actually true and whether issues were missed remain model judgments. Source capture checks for concurrent changes but is not an atomic filesystem snapshot. Provider cancellation is cooperative; late output is rejected. Usage/cost reflects what providers reported.

Binary, non-UTF8, symlink, submodule, unsafe, or unavailable in-scope content is an explicit blocker requiring retry/cancel, not a reviewed file. Numeric file/diff/line limits no longer omit source. A diff too large for one request is paged and reviewed through continuation, not declared complete from a truncated preview. Pure renames retain their old/new names; edited renames can appear as deletion/addition pairs. No failed or skipped work is called clean.

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
