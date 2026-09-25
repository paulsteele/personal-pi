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

For local development in another checkout, start Pi there with `pi -e /absolute/path/to/pi-extensions/pr-review/index.ts` and the compatible Permission System extension loaded; this loads the existing local PR entry without installing a package. This repository's development settings load it automatically here after `/reload`. Global release deployment is a separate action, not performed by this feature.

Setup is complete after `/pr setup approve` activates the saved draft. Edit `profile-draft.json` in your preferred editor; the full path is printed in the transcript. No terminal editor is needed. Choosing a model alone does not activate a profile. Subsequent code, README, manifest, lockfile, or convention changes **do not require setup again**. Old profiles stay compatible; captured current code/docs take precedence over historical profile descriptions.

Host widget/status/overlay updates are coalesced, unchanged summaries are not replaced, and task-detail text is cached. Reviews auto-open a scrollable task dashboard in a filled, accent-bordered panel capped at 120 columns (shrinking to fit narrower terminals). Status icons/colors, a full-row selection highlight, and separate summary/task/details/control sections distinguish it from the underlying transcript. Queued/running/completed/blocked tasks stay visible rather than cycling through one agent's latest activity. Select a task with the navigation keys; Enter switches to full details (scope, model, coverage, usage, recent activity, continuations and retries). **Esc hides the dashboard without cancelling.** Reopen with `/pr status`; use `c` and confirmation or `/pr cancel` to stop. `r` or `/pr retry` resumes blocked work. The compact summary remains available when hidden. Command-launched reviews release Pi's idle command loop immediately, so status/retry/cancel work before Plannotator feedback—not only after it. The agent-invoked `pr_review` tool still waits for its final result. The viewer-ready URL appears in a notification, the live dashboard, and the compact widget when the dashboard is hidden.

Setup and model selection retain their phase spinners and original cancel keys. Approval dialogs are never underneath the review dashboard. `--base` still requires an explicit reference, for example `/pr --base main`.

## Review scope and execution

Each review has five independent **whole-change baselines** plus a whole-change **Architecture / Integration** task. The existing scout proposes coherent related-file areas and optional specialists; validated area assignments route specialists only to relevant scope. Saved always-on specialists remain global. Invalid area plans use an explicit deterministic path fallback without dropping files.

Logical review tasks are **6 + scoped specialist tasks**, not reviewer × diff chunks. Planning, independent verification and optional consolidation are separate stages. Verification packs related claims across files using the selected model's context capacity, up to ten unique claims per batch, and creates as many batches as necessary. Exact duplicate finding bodies (excluding only ID and reviewer attribution) share one independent verdict using the union of their reviewers' required guidance. Every original ID and reviewer is retained; duplicate ledger entries identify the canonical verification ID, including for corrected, dropped, or inconclusive verdicts. Similar claims are never deduplicated. Each full unique candidate body is a mandatory delivery resource: it must be supplied inline or completely paged before any verdict is accepted. A candidate ID or its source diff alone is not sufficient. Semantic consolidation is skipped when no distinct exact groups overlap at locations the grouping rules allow merging. The dashboard distinguishes these logical tasks from harness-initiated model requests, compactions and retries. Provider-internal HTTP retries are not separately observable; usage reflects what the provider reports.

There are **no work-total job, reviewer, turn, token-spend or worker-duration quotas**. The harness supplies complete captured diffs and guidance directly when they fit the model context. Shared policy remains first; common repository background and required documents form a deterministic prefix (`sharedContext`), followed by the specific reviewer assignment and then captured diffs (`suppliedContext`). Shared documents must fit both the fixed prefix cap and the overall inline budget after reserving assignment metadata and JSON framing; skipped documents remain eligible for ordinary packing or paging, without discarding smaller evidence that fits. Lens-specific guidance stays after the assignment. The assignment is supplied up front when metadata must be paged, and restored before retained evidence after compaction. Required reading and scope are unchanged; resources that do not fit remain mandatory, tool-backed context. Normal `read` and `read_change` calls automatically count as supplied context, including legacy line offsets. Reviewers do not need to manage read receipts or checkpoint keys. Intermediate findings/notes can optionally be saved for long reviews. Context pressure triggers compaction and continuation of the same logical reviewer. Context delivery is not proof that every defect was found; the reviewer still owns the complete assigned scope.

A reviewer can explicitly report a blocker for Retry/Cancel; unrelated workers continue instead of waiting behind a global recovery gate. Optional scout failures fall back to the saved roster and deterministic areas, and optional consolidation failures retain exact grouping. Genuine failures do not silently skip mandatory review work. Unsupported content blocks completion rather than being silently skipped. Explicitly approved profile exclusions remain outside scope. If repair requires changing captured source, cancel and start a new review—retry never mixes live edits into an existing snapshot.

`pr_review` exposes the same pipeline to the main agent. Interactive Pi TUI and project trust are required. There is no implicit setup, automatic refresh, separate profile command, or hosted-PR fetching. Existing `/skill:pr` remains unchanged.

## Permission integration

Source-consuming setup and reviews require the **already-loaded local Permission System extension** and
its existing global config. There is no bundled fallback, PR-specific policy file, or general subagent
runtime. Status/model selection and source-free setup edit/approve remain available without the service.

The normal pipeline applies: configured deny blocks, deterministic guards require a human, configured
allow proceeds, and ordinary ask uses the classifier with `/auto` on or a human with auto off. Classifier
failure escalates to a human or blocks without UI. Worker tool capabilities remain snapshot-only/read-only.
A tool-level allow cannot bypass the paths/read effects underneath it.

Policy and auto mode are **live at action boundaries**, including after pending decisions and before
outgoing context. Editing filepath rules or toggling `/auto` needs no restart. Invalid/unreadable config
fails closed. Existing main-agent automatic-allow memoization is preserved and used separately within
each worker turn; changes to relevant policy/context, a new turn, or retry invalidate it. There are no
run-long file grants, shared worker approvals, or cached human answers. Parent session grants are not
implicitly inherited by workers.

Human prompts run in a shared parent queue and identify the worker/action. The PR dashboard automatically
minimizes before any permission prompt—including a main-agent prompt during background review—and cannot
reopen while that decision is pending. It stays minimized afterward until you use `/pr status`, so later
work phases cannot unexpectedly steal focus. Minimizing the dashboard makes no permission decision; Esc
on the visible permission controls still means deny. Setup's separate phase spinner also yields to permission
and note controls, then restores its progress/cancel UI without restarting the worker. Automatic checks,
execution-slot waits, and queued/visible human approvals have distinct task statuses. Source preparation,
context packing, and provider preflight keep their bounded execution slot; explicit recovery can release
it, and slot reacquisition is labeled separately from permission checking.
Cancellation removes queued requests and dismisses active approval UI. Denied mandatory inputs prevent
completion; `/pr retry` explicitly rechecks under current rules against the same valid snapshot.

Checks cover preparation, changed/unchanged/baseline source, read/search/diff tools, inline resources,
source-derived candidate transfers, report publication and viewer/handoff. Each recipient worker must
be authorized; a capture approval or another worker's finding is not a grant. Current-run outputs carry
a conservative host-owned source dependency set, so text quotes cannot bypass a recipient's restrictions.
Source paths and metadata—not protected file contents—are supplied when requesting permission. Each
outgoing dependency set must finish authorization under one stable revision; a change restarts the complete
pass. Bulk checks yield to terminal input/cancellation, and provider dispatch rechecks freshness after
authentication and other awaited preflight work, including compaction. Tool coverage/checkpoint updates
commit only after the outer permission guard accepts the result.

Approved profile exclusions control review scope, **not file access**. Excluded/unneeded dirty files are
kept as metadata until requested; a later read requires permission and matching captured identity. If
that deferred source has changed, start a fresh review instead of mixing newer bytes into the snapshot.
Denied mandatory guidance is not treated as a stale missing document.

`search_source` separates local matching from disclosure to a worker. The trusted harness can scan ordinary
repository-contained snapshot files without resolving their `ask` rules first. Explicit tool/read/path/skill
denies and deterministic sensitive-path guards prevent the scan; those files are reported as skipped
coverage, not searched with zero matches. External destinations are not eligible. Files with no matches
cause no classifier/human request and add no continuing context dependency. Matching lines pass the normal
read/skill permission gate before they are returned, and only delivered matches become dependencies for
later model requests or transfers. A rejected outer tool result commits no new dependencies. Local checks
and disclosure checks both honor live policy changes and cancellation. Older permission services without
local-search support fail closed. This changes only snapshot search, not ordinary reads or skill invocation;
matching files can still require approval again on later turns. Search reports denied/unavailable coverage
rather than silently returning a complete negative result.

Snapshot and provider prompt caches remain performance mechanisms, not permission grants. New denials
also apply to cached source and outgoing worker history/summary dependencies. Already sent context,
older approved profiles, and historical reports cannot be retroactively recalled or scrubbed. Git may
internally inspect files/attributes during metadata discovery; this integration is not an OS sandbox or
a content-based secret scanner. Infrastructure storage/authentication and trusted extension code retain
their ordinary authority.

## Fixed rules versus generated context

All shared methodology, personal-global rules, baseline focus text, and stage instructions live in `prompts/` **in this repository**. They are loaded afresh per invocation. Update these files to evolve review behavior across projects.

Generated context is subordinate data: repository summary, document references, supplemental baseline focus, specialists, path/added-line/removed-line triggers, exclusions, and source fingerprints. It cannot disable stages or the five fixed baselines: Security, Performance, Correctness, Style/Conventions, and Human Readability. There is no hand-maintained per-repository fixed layer.

**Human Readability** (`readability`) checks high-level intent, accurate variable/function names, cohesive intent-revealing functions instead of temporal narration, and diff hunks that make semantic changes easy to review. It flags concrete introduced comprehension problems—not arbitrary naming preferences, mandatory extraction, or hunk-size limits. Useful rationale/ordering comments and necessary refactors remain welcome. Readability findings use the same independent verification and evidence requirements as other baselines; a runtime bug is not required. Existing profiles need no new baseline entry: optional `baselineFocus` supplements the fixed lens.

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

When the local Pi Permission System extension is loaded, a finished `/pr` or `pr_review` registers the
**exact saved report file** for external-directory access in the current session before publishing its
result. Reading/searching that report no longer needs a separate external-directory classifier prompt.
This does not allow the reports directory, other runs/repositories, profiles, snapshots, or viewer data.
The grant is memory-only, ends on session shutdown/replacement or `/reload`, and never changes permission
configuration. Normal tool/Bash/path rules and safety guards still apply; the allowance is not read-only
enforcement and does not authorize fixes. Source-consuming review now requires the permission extension;
this exact-file allowance is still a separate, optional convenience for the parent report read.

The default remains **four concurrent workers**. Schema-version-2 preferences contain model/reasoning, concurrency, report retention, and `requestTimeoutMs` (default five minutes **per provider request**, not per reviewer). A request timeout causes recovery or a pause, never quota-based scope removal. Existing v1 preferences are normalized on read with a visible notice: old job/reviewer/turn/input/file/diff quotas are ignored. Loading does not rewrite config; a later explicit model save writes v2. Invalid/unknown settings are still refused. Full-scope reviews can take longer and incur more cost than capped partial runs; use the task metrics rather than assuming fewer tasks always means lower latency.

## Browser workflow

Requires an **already-loaded Plannotator Pi extension**, with no version allowlist. The installed package must provide the review server, viewer assets, and APIs used by the isolated helper. Missing APIs or invalid viewer responses still fail closed without authorizing fixes. The harness never installs, updates, forks, vendors, or patches Plannotator. After loading or changing the extension, run `/reload` and retry `/pr`.

The existing server and HTML renderer run in a small isolated UI helper—not another Pi agent. The parent streams the captured diff into a private viewer-owned aggregate with backpressure; only the helper materializes it for the renderer. The helper checks the owning parent and refuses symlinked/non-regular inputs. It receives only the captured diff and verified annotations. Ask AI and sharing are disabled for this helper, and its data is confined to private Pi storage. Your ordinary Plannotator settings and other open reviews are untouched.

The browser is a snapshot-only diff view with surrounding context, not a live repository browser: no branch switching, staging, live file expansion, or fallback to a different checkout. Verified findings appear as existing comments, including original severity, reviewer labels, and evidence. Architecture may also produce clearly labeled **unverified design advisories**. Their quoted locations are checked, but the design judgments do not receive an independent model pass. Advisories are discussion-only general comments with no authorized finding IDs; submitting, editing, or replying to one never authorizes automatic fixes. Plannotator can show a generic “Uncommitted changes” mode label without live Git metadata; the summary comment and saved report contain the authoritative requested scope, baseline, HEAD, and captured fingerprint.

- **Send Feedback** requests fixes for the verified finding comments in the submitted payload. Remove findings you do not want fixed. Merely hiding/filtering comments is not selection.
- **Questions, objections, edited findings, and reply threads** return to the main agent for discussion; they are not blanket approval of the original suggestion.
- **Approve/LGTM or Close** requests no automatic fixes. Approval notes may still be discussed.

Every returned command/tool report explicitly states its browser outcome and authorized IDs—even when none are authorized or the viewer fails. Approval notes are handed back for discussion, and truncated output retains a full-report locator. No second Pi selection screen is shown. Source drift, malformed/stale IDs, a failed viewer, or incomplete seeding cannot authorize fixes. The main agent reads the full report/feedback before implementing requested changes under its normal permissions and test workflow. This harness does not apply patches or run project tests itself.

Output-permission recovery remains inside an inspectable work phase. A failure of the final source check
clears persisted requested fix IDs, marks the report incomplete, and returns an updated no-fix handoff with
the full report locator.

## Review guarantees and limits

Code enforces stage order, mandatory baseline presence, worker tools, coverage-ledger closure, per-request/schema boundaries, evidence matching, verification accounting, and browser-to-finding identity. Review workers only read/search/list captured repository content and submit structured results. They have no shell, write, network, or arbitrary extension tools.

Source capture refuses active clean/process filters selected by current or staged Git attributes, rather than executing repository conversion commands. Configured but unused filters are allowed. Index flags such as assume-unchanged/skip-worktree cause an explicit refusal; the harness never clears your flags. A shallow checkout with unavailable first-parent history is not mistaken for an initial commit.

Captured working-tree data and immutable Git blobs have private backing files; large exact diffs run off the TUI thread. Cursor and line-offset reads use sparse UTF-8/line indexes and can continue within a long line. Changed-line ranges are computed during off-thread diff generation, so evidence checks do not reread/reparse entire patches. Cache/page capacity controls resource use, not eligibility for review. Reviewer/verifier inputs use actual JSON sizes to decide what to inline versus page, never to drop work. Verification retains the **per-batch** ten-candidate limit and complete mode/rename metadata.

Whether a finding is actually true and whether issues were missed remain model judgments. Source capture checks for concurrent changes but is not an atomic filesystem snapshot. Provider cancellation is cooperative; late output is rejected. Usage/cost reflects what providers reported. Cache reads/writes, total tokens, and cost components are preserved through task/report totals and agent-tool usage. Task details and reports distinguish first requests, continuations/retries, and compaction through aggregates, not persisted per-request histories. Reports also show stage totals; missing cache metrics in older reports are labeled unavailable rather than zero. Provider-internal HTTP retries remain unobservable.

Each logical worker has its own routing session ID, stable across its continuations and recovery but never shared with concurrent workers. Provider/SDK/environment cache-retention defaults are unchanged; one-off compaction requests retain the SDK's separate routing and no-cache-write policy where supported. Shared prefixes enable reuse but neither routing hints nor prefix ordering guarantee a provider cache hit. No model results, browser approvals, or fix authorizations are cached across runs.

Binary, non-UTF8, symlink, submodule, unsafe, or unavailable in-scope content is an explicit blocker requiring retry/cancel, not a reviewed file. Numeric file/diff/line limits no longer omit source. A diff too large for one request is paged and reviewed through continuation, not declared complete from a truncated preview. Pure renames retain their old/new names; edited renames can appear as deletion/addition pairs. No failed or skipped work is called clean.

## Development and verification

```sh
bun run --cwd pr-review check
bun run test:integration
```

The normal tests use synthetic repositories and fake providers. The separate compatibility probe uses existing installations supplied explicitly, never downloads. It checks the installed review server and captured-annotation workflow rather than a version allowlist; use it after upgrades to detect API incompatibilities:

```sh
PR_REVIEW_TEST_PI_PACKAGE=/path/to/installed/pi-coding-agent \
PR_REVIEW_TEST_PLANNOTATOR_PACKAGE=/path/to/installed/pi-extension \
bun run --cwd pr-review test:compat
```

Supply those same environment variables to `bun run --cwd pr-review test:browser` for an explicit human browser smoke test: it opens a synthetic review with two findings, asks you to remove F2 and submit F1, and reports the returned IDs without applying any fixes.

Supply those same environment variables to `bun run --cwd pr-review test` to include the production viewer's synthetic HTTP round-trip. It opens no browser, makes no model calls, uses temporary directories, and never submits feedback to a real user review. A real browser smoke test and any model-backed review must be performed separately and deliberately.
