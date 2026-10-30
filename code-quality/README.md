# Code Quality

An interactive post-edit quality gate combining automatic LSP diagnostics, indexed DRY judgment, and isolated human-readability review. The main agent and isolated reviewer receive the same readability preferences as enforced requirements. The readability reviewer assesses exact changes and returns `approved` or `needs_work`. Its rejection must identify the preference violated by the changed content and propose a bounded edit addressing that readability problem; the separate DRY contract uses citations and a correction direction instead. A readability violation does not need to cause a functional defect. The reviewer cannot browse the repository, run commands, or change files.

## Configuration

Use `/quality-model` to select an available provider/model, or `/quality-model provider/model` to save one directly. There is **no default model and no fallback** to the main agent or progress observer. Configuration lives at `~/.pi/agent/extensions/code-quality/config.json`. An unset model pauses the first in-scope review for configuration. Invalid configuration is reported rather than overwritten.

```json
{
  "enabled": true,
  "provider": "your-provider",
  "model": "your-model",
  "timeoutMs": 30000,
  "maxFileBytes": 262144,
  "maxBatchBytes": 1048576,
  "maxInputChars": 128000,
  "maxOutputTokens": 16000,
  "dryEnabled": true,
  "dryScanTimeoutMs": 60000,
  "dryMaxInputChars": 24000,
  "dryMaxOutputTokens": 1024
}
```

The input and output defaults are 128,000 characters and 16,000 tokens; the selected model's output and context limits still apply. Existing saved limits remain unchanged, so update `maxInputChars` and `maxOutputTokens` in an existing config if you want the doubled defaults. The provider/model values above are placeholders, not defaults. `/quality status` shows current state; `/quality on|off` controls the gate. Disabling a pending gate requires confirmation and records a waiver. `/quality retry` resumes a pending review; `/quality resolve` reopens a proposal decision when one is available. Config changes can be loaded with `/reload`. `/quality on|off` is the persistent master switch for automatic readability and LSP checking. An enabled project LSP profile remains saved while the master switch is off; `/quality lsp status` reports it as suspended, and `/quality on` resumes checking.

When the operator turns the sandbox off for a session (`/sandbox off`, the Sandbox Settings toggle, `--no-sandbox`, or `PI_SANDBOX=off`), quality suspends its gate for that session only. Any pending case is closed as waived without a prompt, and a `code-quality:waiver` entry records it. LSP and DRY stop locally, and status shows `quality: off (sandbox off)`. The saved `enabled` setting is unchanged. When the sandbox is ready again, the gate resumes, and new sessions start with the gate active.

## Automatic LSP operation and overrides

Trusted TUI projects with quality enabled use provisioned language servers automatically, without `/quality lsp setup` or a saved profile. The sandbox provisions all five servers and their private supporting runtimes as read-only artifact image mounts; quality starts relevant servers when supported files are checked. Installation and image rebuilds are never part of LSP setup.

The client infers TypeScript/Python roots from project markers, prefers Go workspaces over individual modules, asks Cargo for its workspace, and opens an unambiguous C# solution/project. Missing or ambiguous project information is reported instead of silently choosing a solution or claiming clean diagnostics. Server settings and project dependencies still determine actual analysis. Use a private override for nonstandard interpreters, ambiguous workspaces, custom servers, or disabled languages.

Discovery runs against guest-accessible files using Git-listed files or a bounded directory scan. Dependency directories and symlinks are excluded; a truncated 10,000-entry scan is explicit. Approved external files remain eligible. Distinct session/container generations never share a host server.

`/quality lsp setup` is now an optional override editor. Its checklist and Advanced controls retain custom servers, executable paths, roots, settings, and timeouts. Validate and enable saves the override only after runtime validation; no installation is proposed. Missing provisioned servers direct you to sandbox provisioning. Existing approved profiles retain their language subset and settings. A profile with `mode: "auto"` combines inference with explicit routes and `disabledLanguages`; absent mode retains legacy explicit-route behavior. Master quality-off and project LSP-off prevent automatic analysis.

```text
/quality lsp setup                 Optional language/workspace overrides
/quality lsp setup edit            Open a private editable draft
/quality lsp setup approve         Validate and approve that draft
/quality lsp setup discard         Confirm deletion of the private draft
/quality lsp status                Configured servers, states, sharing, failures
/quality lsp doctor [server-id]    Check the real project's diagnostic support
/quality lsp restart [server-id]   Restart a shared server after confirmation
/quality lsp on|off                Enable/disable the project profile
```

Presets are Roslyn for C#, TypeScript/JavaScript, Pyright, rust-analyzer, and gopls. Custom **stdio servers with pull diagnostics** remain supported; ReSharper standalone is not. The pinned Roslyn package is a prerelease. The sandbox's managed runtimes launch servers without replacing the application's Node/.NET/Go/Rust installation. Project-specific SDK versions, dependencies, virtual environments, and matching Rust source components may still be required; put those requirements in the project environment, not LSP setup.

Profiles live under `getAgentDir()/extensions/code-quality/repos/<repo-id>/lsp-profile.json` (or `projects/<folder-id>/` for non-Git projects). Git worktrees share configuration using the same common-directory identity algorithm as PR profiles, but distinct worktrees have distinct servers. Roots and C# project/solution paths are relative to the checkout. Non-Git descendants use the closest configured ancestor. Multiple routes at the deepest matching root can check the same file. Edit the private draft to change environment overrides, server settings, roots, extensions, or deadlines; the active file rejects unapproved manual changes. Settings field edits and the Settings setup wizard validate and activate accepted edits without a second confirmation or Apply button. Standalone setup commands retain their explicit approval flow.

An unapproved edited draft blocks `/quality lsp on|off`. Use `/quality lsp setup approve` to validate and activate it, or `/quality lsp setup discard` to delete it after confirmation. Discard affects the shared project's draft only: the approved profile, running servers, and pending quality case remain unchanged. A draft changed while confirmation is open is not deleted; rerun the command to confirm the new revision.

Managed servers run inside the project container from read-only image mounts under `/opt/pi-tools/<server>/<version>/`. Project images do not build against these servers or their private runtimes; application SDKs and dependencies remain project-owned. Server caches use writable locations outside the tool mounts. The existing retirement/generation checks restart servers after mount changes and tooling recreation; the sandbox inventory supplies executable paths and provisioned versions. Known legacy managed paths are resolved against that inventory. Custom executable paths remain explicit. Ordinary automatic routes stay in memory; private drafts/approvals are used only for overrides. A file without an applicable supported language proceeds to readability review without a claim of clean LSP coverage; failure of an applicable server enters the existing retry/waiver flow.

### Local shared-broker migration reference

The following shared-server lifecycle describes the retained local broker/probe implementation used by tests and migration tooling, not a host fallback for the loaded extension. The container implementation owns servers per session/container generation and retires them before recreation.

### Shared server lifecycle

At TUI startup, configured servers warm in the background. Pi instances with the same agent storage, physical workspace, executable/configuration, and relevant environment attach to one local broker and one LSP. Different worktrees or incompatible configurations do not share. The broker owns document versions and reads current disk snapshots; each Pi keeps its own case, correction counter, and operator decisions.

Closing or reloading one Pi releases its connection without stopping other clients. The last client disconnect triggers LSP shutdown and bounded process-group cleanup. A process guard handles broker loss; deliberately detached custom daemons and simultaneous uncatchable termination of broker and guard are outside that guarantee. `/quality lsp restart` affects all attached clients and invalidates pending results. Status reports the shared generation and client count. If the workspace watcher fails, checks remain unavailable: close every Pi session attached to that workspace before reopening any of them. Sequential reloads keep the failed shared broker alive and do not recover its watcher.

Language servers are trusted local processes, **not a sandbox**. They can read dependencies, execute project analyzers/build tooling, restore dependencies, and write caches. The broker inherits selected toolchain/locale/proxy variables plus approved route overrides, not arbitrary Pi session/model variables. The client never applies formatting, code actions, or server-requested edits. File-scoped feedback does not constrain what the analysis process internally reads or executes.

### Diagnostic gate

Successful `edit`/`write` results include a compact diagnostic preview; a diagnostic rejection does not mean the file write failed. At the batch boundary the gate reconciles the final snapshot, runs LSP first, then DRY, and only invokes readability after earlier applicable stages are clear or explicitly waived.

**Errors, warnings, information, hints, and unspecified-severity diagnostics all block**, including findings that predate the edit. Their original severity is preserved. Project/server rules and suppressions still determine which diagnostics exist. Findings outside edited files are not added to the case. Unsupported content, unconfigured routes, missing results, and failures are never labeled clean.

LSP findings use the same initial rejection plus five response rounds, disagreements, and operator arbitration as readability findings. A disagreement reruns LSP; the model cannot dismiss a diagnostic. Without a patch, arbitration offers current code or five more rounds. An exact operator-approved readability patch must still pass LSP afterward. Explicit LSP-only waivers are recorded separately from clean diagnostics.

Roslyn project/solution loading errors from `window/logMessage` or `window/showMessage` fail setup promptly and remain visible in `/quality lsp status` and the setup error. Details retain the SDK requirement and configuration path, omit stack traces, and are bounded. An initialization-complete notification cannot override a recorded load failure; warnings and unrelated server logs do not become project-load failures.

Server failures pause for retry, reconfiguration, or waiver without consuming correction rounds. Defaults are 60 seconds for startup and 10 seconds per file diagnostic operation, configurable in the draft. A timeout or empty clearing notification is not a pass. File hashes, observed workspace changes, provider registration, and server generations invalidate stale results; these checks are not an atomic filesystem lock.

Scope is macOS/Linux/WSL TUI sessions. The current real-server validation was on macOS arm64; Linux/WSL and larger real-world solutions still need field validation. See [lsp-compatibility.md](lsp-compatibility.md) for pinned versions, protocol quirks, reproducible probes, and measured tiny-fixture latencies. Clean LSP diagnostics are not a full build, test, or correctness certification.

## Indexed DRY checking

DRY is enabled by default in trusted interactive sessions and uses the **same configured quality provider/model** as readability. It searches the guest-visible owned repository using jscpd 5.4.1 exact/renamed/gap/AST clone results plus identifier, call-shaped API, and distinctive-literal retrieval. The judge receives only selected original pairs and bounded neighboring code, not the repository or main conversation. Similarity nominates evidence; it is never itself a blocking verdict. Documentation examples, explicit test inputs/assertions, independent policies, and externally prescribed fields are protected by [dry-policy.md](dry-policy.md).

DRY findings cite changed lines and counterparts, identify shared knowledge/ownership, and give a correction direction; they **do not require an exact diff**. They share the existing initial rejection plus five correction/disagreement rounds and arbitration with other stages. Finding-only arbitration offers Accept current or another five cycles. Readability retains its exact-patch contract. A case-only DRY waiver does not waive LSP/readability, and a readability size waiver does not dismiss a required DRY check.

jscpd is a pinned, checksum-verified `quality-tool` mounted read-only at `/opt/pi-tools/jscpd/5.4.1/bin/jscpd`; the packaged guest worker uses the provisioned private Node runtime. New default Sandbox Tools profiles include it. Existing profiles are never silently rewritten: add the verified jscpd catalog entry in **Settings → Sandbox → Global Sandbox Tools** or `/sandbox setup global tools`, then reload and approve the normal rebuild. DRY never installs software, runs a host binary, or downloads embeddings. The guest worker owns a private jscpd stdio MCP process for baseline/snippet queries; those tools are not registered with Pi or exposed to the main agent. A guest-local socket carries bounded worker requests, with no host port or private-storage mount. jscpd's AI reporter is compact location formatting, not an AI judgment; the adapter consumes validated JSON instead.

Project profiles live outside the checkout:

```text
getAgentDir()/extensions/code-quality/{repos|projects}/<project-id>/dry-profile.json
```

Worktrees share configuration, not live analysis state. **Each session keeps one DRY baseline and updates it incrementally at the start of every assistant turn.** The first turn captures sources and starts a private jscpd process. Each later turn compares every discovered file's size and modification time with the previous capture, restages only changed files, deletes removed ones, and asks the same jscpd process to rescan. Only changed lexical index files cross back to the host, and a turn with no changes exports nothing. The persistent worker prepares revision-scoped export shards once; the host reads them through the existing persistent sandbox filesystem transport, not a new worker process per page. Shards are at most 512 KiB and carry validated byte counts and SHA-256 hashes. A lexical file may span shards without excluding its source; manifest, report, and index metadata must agree before readiness is published. Profile or configuration changes, sandbox generation changes, manual refresh, and any update failure rebuild the baseline from scratch.

Edit/write batches query current edited code against the current token/AST and lexical baseline without rescanning. Checks wait for the in-flight baseline if necessary. New files can be queried even when absent from the baseline. Startup only validates tooling; ordinary writes do not start scans or invalidate the baseline. A restored pending check without a turn-start event creates a baseline on first use.

Every selected pair still receives a fresh isolated judgment; judgments and prior case approvals are not reused. Only selected counterpart files are reread before requests and after judgment. Changed, deleted, or undisclosable counterparts are dropped rather than triggering a repository rescan. Edited-source freshness and sandbox ownership checks remain, but there are no whole-corpus validation walks during DRY or readability review.

Source staging and bounded metadata transfer use a session-private guest directory, removed on shutdown/retirement and rebuilt whenever the baseline is rebuilt from scratch. Selected evidence remains in the existing private case store for feedback and audit; it is not an approval cache. Old private DRY cache directories are no longer read or written and are not automatically deleted. Existing profiles can retain their retired `maxCacheBytes` field; loading discards it, and saving removes it.

The baseline deliberately lags same-turn edits: newly introduced counterpart code may be missed until the next turn's update and a subsequent applicable check. There is no final full-repository scan. Overlapping matches against the edited file's old region are excluded; distinct same-file regions remain candidates, though a modified counterpart file can be discarded by targeted validation. Repository capture is not an atomic snapshot, and source changes during background capture do not force another scan.

The adapter's explicit source-extension map supports many languages and can be extended through the project profile; jscpd's format catalog count is not a claim that every format is indexed. Token/extension coverage is broader than AST support; automatic AST test exclusions and source suppression markers remain visible coverage limits. Short rules can be nominated lexically. Unsupported documents/generated files are labeled, applicable omitted source pauses for recovery, and no-candidate outcomes are not model-approved or exhaustive DRY certification. Larger checks wait visibly; five seconds is not an approval deadline.

**Feature contract.** Lexical features and evidence signals share a 160-character bound, including the feature-family prefix. Oversized values are represented as `<family>:sha256:<full-value-digest>` rather than truncated; literal values beginning with the reserved `sha256:` marker are also hashed. Identifier/word normalization remains unchanged. Invalid lexical output reports the source path and validation location instead of dropping that source.

**Baseline budget and status.** `dryScanTimeoutMs` bounds the entire baseline build or incremental update, including capture, detector readiness, export preparation, and transfer/validation; successful pages do not renew it. Failure or interruption never publishes readiness. Provider calls retain their separate review deadlines. `/quality dry status` shows the current baseline phase, total elapsed duration, phase timings, lexical transfer bytes/shards, and separate detector-analyzed versus lexically indexed file counts. Detector time is not end-to-end baseline latency, and threshold-filtered files may still be indexed lexically.

**Corpus limits.** Untracked-file discovery is scoped by the profile's `exclude` prefixes, so Git never walks excluded trees. When the eligible corpus exceeds `maxSourceBytes` (default 128 MiB) or discovery exceeds `entryLimit`, the scan stops with an error rather than silently dropping files. The error lists the largest directories and a working `"exclude"` value to paste into the project profile, then `/quality dry refresh`. Ordinary exclusions (dependency directories, binaries, sensitive files) leave the scan `ready` and only add to the excluded count.

**Vendored-directory warning.** A ready scan warns, without blocking, when it includes directories that look vendored or generated: NuGet or CocoaPods package markers, `Pods`, `Carthage`, `third_party`, NuGet `.store` directories, or `.gitattributes` `linguist-vendored`/`linguist-generated` paths. Add such directories to `"exclude"`, or to the profile's `"include"` list to keep scanning them without the warning.

Use **Settings → Code Quality → DRY Checking** for enabled state, scan/input/output budgets, project thresholds/exclusions/format mappings, and Show status or Run fresh scan actions. Keyboard equivalents:

```text
/quality dry status
/quality dry refresh
/quality dry on|off
/sidebar quality
```

Disabling a pending DRY requirement requires an explicit operator decision. Master quality-off suspends analysis and every gate stage. Tool/scan readiness in the pinned Sidebar header and Quality tab means infrastructure health, never code approval. The tab shows scope, scan state, clone modes/counts, coverage, latest check, and recovery status; presentation events carry no source or finding rationale. `/quality dry refresh` replaces the baseline, not a model review or waiver; subsequent checks query that baseline until the next turn.

## Review and arbitration

The gate waits at the end of an assistant's edit/write batch. Changes to one file coalesce. A rejected batch opens one case; the main agent has five response-and-review rounds after the initial rejection. A response can be a code correction or a bounded disagreement submitted to the reviewer; both use the same counter. Read-only investigation, tests, and infrastructure retries do not consume rounds. Corrections may edit additional files directly without a separate scope request or approval; those edits join the current case and retain ordinary permissions and quality checks. When applying an exact user-approved proposal, only its files may be edited.

The agent uses `quality_response` to submit a disagreement. A disagreement returns to the reviewer at the batch boundary rather than immediately interrupting the operator. The reviewer can approve the existing code or return fresh readability feedback. Automatic operator arbitration occurs only after five completed response-and-review rounds remain unresolved; approval on round five closes the case normally. A premature attempt to finish while feedback is unresolved requests reconsideration and consumes one round only when the reviewer responds, rather than escalating early.

At the limit, the terminal panel offers:

- **Accept original:** approve the current agent-written snapshot, not an earlier version.
- **Accept proposed:** when a validated readability patch exists, approve it for application through ordinary permission-checked tools. Closure requires exact resulting hashes and resolution of nonwaived LSP diagnostics and DRY requirements.
- **Allow another five cycles:** continue with five additional response-and-review rounds, preserving the counter and case notes.

Use ↑/↓ to select a choice, then Enter to resolve it immediately without notes. Press `n` instead to add optional multiline, case-only notes; Enter saves the notes and resolves that choice without another confirmation. Shift+Enter inserts a newline. Escape from either view leaves the case unresolved. The panel shows source-labeled findings, current code, and a scrollable current/proposed diff when a patch exists. Accepting current code is final for that snapshot and records any outstanding or unrun checks; it is not a model or clean-LSP verdict.

Invalid reviewer submissions, including out-of-scope findings or proposals, get **one immediate repair attempt**, not five identical retries. Every request lists eligible finding lines separately from visible edit-context ranges. The repair receives the validation error and a bounded excerpt of the rejected submission, and must return a fresh complete verdict. A second invalid submission stops for retry, model selection, or an explicit user waiver; it is neither an approval nor a readability rejection. If the repair cannot fit the input/context budget, the gate automatically waives that file without sending the repair or truncating reviewed code. Any earlier chunk findings for the waived file are discarded; eligible files continue through review.

Provider failures have a separate budget: the first four failures wait 2/4/6/8 seconds before retrying, and the fifth stops. Each request has its own timeout. This budget is shared across the initial submission and its repair; transport retries preserve repair feedback and do not grant another repair opportunity. Provider failures and invalid submissions do not consume readability rounds. Cancellation never means approval. Failure/configuration prompts, content-authorization prompts, and ordinary permissions remain separate from the five-round readability exchange. The operator can still explicitly invoke `/quality resolve` to intervene sooner; the agent cannot self-approve or use it as an automatic early escalation.

## Compact review log

Each review pass displays `quality check: lsp`, `quality check: dry`, and `quality check: readability` as applicable. Unfinished stages carry live elapsed timers (for example `quality check: dry · 2.4s`), and completed stages retain frozen durations. Timers include startup/current-scan waits, batching, retries, and validation, stop before operator recovery, and update without Sidebar. Reload/tree changes restore unfinished entries as interrupted rather than running indefinitely. Each stage's line gains `✓` on successful checking or `✕` on rejection or failure; no-candidate DRY checks remain distinguished in receipts rather than labeled model approvals; outdated and interrupted checks are labeled explicitly. Completed stage results survive reloads and follow the active session branch. Retries and file groups within one pass do not add duplicate checking lines or increase the pass count.

The outcome remains `approved`, `handling rejection N`, or an explicit `waived` rather than claiming approval for a waiver. Rejection numbering starts at 1 for the initial rejection and advances with unresolved response-and-review rounds. Rejections show the reviewer's rationale and file/line findings (or LSP diagnostics) without expansion. Expand feedback to inspect full case IDs, snapshot details, protocol instructions, and proposed edits; the executing agent still receives the full feedback. Checking lines and their completion updates are presentation-only and are not added to model context.

## Sidebar status

Sidebar shows `󰅴 quality · provider/model` in its pinned status area above the turn indicator and Tools/Summary/Sandbox selectors. Configured LSPs append their names and running state, for example `roslyn ● ready ×2 · typescript ⟳ checking`; entries wrap at narrow widths. The multiplier is the number of attached clients. `ready` means the server is usable, not that all code is clean. Aggregate quality outcomes remain on the corresponding tool rows.

Each corresponding edit/write entry has an inline `󰅴` badge beside its permission badges: `✓` for approval, `✕` for needs-work/blocked, `?` for pending review or intervention, and a dim `–` for skipped/unreviewed states. Colors match the classifier: model approval is purple, user approval cyan, negative outcomes red, and pending outcomes amber. There is no separate quality row; detailed state and counters remain in `/quality status` and the review feedback. Calls reviewed together share the batch result without adding model requests. Starting a correction batch preserves the previous batch's result rather than rewriting its history.

Sidebar consumes bounded, session-scoped `code-quality:status` and `code-quality:activity` events. No code, rationale, or case snapshots are sent through these presentation events. The header replays for late consumers; per-call display history is memory-only and clears on reload or branch changes. Gate recovery remains independent of the sidebar.

## Desktop notifications

When the desktop-notifications extension is loaded, quality dialogs notify an unfocused terminal's user through the existing macOS/Hyprland notifier. This covers choosing current/proposed code at arbitration, authorizing file review, recovering a failed review, selecting a reviewer, and confirming a waiver. Routine review and agent-handled rejections stay silent.

The controller brackets each wait with `code-quality:attention` events containing only `version: 1`, session/request IDs, a decision kind, and an `active` boolean. A matching end event, session reset, or shutdown retires the notice. These transient events carry no source, paths, findings, or provider errors, and notification failures cannot approve or block a quality decision.

## Coverage and policy

Covers explicit `edit` and `write` tools in **TUI sessions only**. Print/JSON/RPC are explicitly inactive. Shell scripts, formatters, arbitrary custom tools, and independent subagents are not comprehensively detected. Hash checks invalidate observed changes to tracked files, but are not a lock against external editors.

All edited text is eligible for readability review, with purpose-aware treatment of source, tests, documentation and configuration. The isolated model's findings concern names, meaningful structure, explanatory comments, self-describing contracts, and how tests communicate scenarios and expectations. Unused imports/variables, formatting, lint, suspected bugs, missing error handling, coverage, assertion exhaustiveness, performance, security, and API compatibility are outside the model's readability review—even when a concern is valid. Configured LSP diagnostics are a separate source of findings in the same gate. The formatter owns mechanical layout. Changing an assertion is not grounds for demanding that previous behavior be restored.

The canonical rules are in [policy.md](policy.md), with calibrated contrasts in [examples.md](examples.md). They remain requirements, not advisory preferences. Without this extension, the policy can be copied into your personal AGENTS.md; the extension itself does not modify global instruction files.

Known generated and lock filenames in `exclusions.ts` auto-approve without body capture or model calls. Receipts distinguish `auto_approved`/`reviewed: false` from a model verdict. Exclusions do not bypass ordinary permissions or make failed tools succeed. Binary/non-UTF-8 content is explicitly not reviewed. Oversized files are automatically waived without a dialog when they exceed `maxFileBytes`, the remaining `maxBatchBytes` snapshot budget, an indivisible hunk's input allowance, or a review/repair's complete input/model-context budget. Batch planning considers files in capture order and continues considering smaller files after a waiver. A waiver excludes the whole file, not just its oversized chunk. Per-file receipts and badges say `waived` with `reviewed: false`, never model-approved; a mixed batch reports the eligible approvals alongside its waivers. Waivers survive pending-case reloads and do not exempt later edits from capture. Size waivers do not dismiss LSP findings or failures: captured files still run LSP before readability budget checks; files too large to capture have no claimed LSP coverage. Sensitive content still requires a user decision; external mounted files do not require repository-membership authorization. Changed hunks are never silently truncated to claim complete review.

A style approval is not a correctness/security certification. Unapproved code has already been written when assessed. Keep ordinary tests and PR review, especially after structural changes.

## Privacy and persistence

For readability, the configured provider receives policy/examples, exact changed hunks plus bounded surrounding code, and any case notes. DRY sends its separate policy and selected changed/counterpart pairs; both follow the same case/provider sensitive-content authorization. Hunks from the same file are grouped into one request when they fit the input budget, retaining every changed hunk and its original line numbers. Larger files split only at hunk boundaries; each group declares its included and total changed-hunk counts. These remain excerpts, not a claim that the entire file is visible. The reviewer must use all supplied hunks together and not infer missing code from omitted context.

The reviewer does not receive the requested task or main-agent conversation. A submitted disagreement is a separate, bounded argument (at most 2,000 characters), not hidden reasoning, policy, or operator authority. Each review call uses fresh isolated context, current code, prior findings, and the latest submitted disagreement when applicable. User notes remain distinct and authoritative for the case. Code changes or a stale snapshot clear the old disagreement so it is not applied to a different revision. The reviewer still assesses readability independently of the requested behavior change. Best-effort secret detection cannot guarantee detection of arbitrary sensitive data. Sensitive paths and detected secret shapes require authorization; authorization is scoped to the case/provider.

Pending case snapshots/proposals are private files under `~/.pi/agent/extensions/code-quality/cases/`, outside the workspace, with restrictive permissions. Session entries hold content-addressed references and decision metadata. Reload, resume, fork, and tree navigation restore active-branch state and revalidate current files. Missing/corrupt state pauses rather than silently passing. Source-bearing snapshots are retained for recovery; no automatic pruning is currently performed. Do not share session/runtime data without reviewing it.

Model-call usage, latency and retries are recorded as extension metadata, not fabricated into the main model's token totals. Pass receipts display `approved`; rejection receipts display `handling rejection N`. Full feedback is available by expanding the entry. A premature streamed “done” does not override a pending gate.

When the reviewer provider is exactly `litellm`, all quality calls for one Pi session share the LiteLLM log session `pi-<encoded Pi session ID>-quality` via `x-litellm-trace-id`. This includes chunks, retries, validation repairs, corrections, and disagreements across cases. Resume, reload, and `/tree` retain the group; new sessions, forks, and clones get their own groups. Main-model calls remain separate. This is log correlation, not shared conversation context or a change to SDK routing/cache IDs. Other providers and aliases are unchanged; standalone calibration without a Pi owner adds no session header. Existing logs are not migrated.

## Development

Normal tests use fake LSP processes and do not install servers. `bun run --cwd code-quality test:lsp-tui` runs an opt-in two-instance pseudoterminal smoke with the loaded Devcontainer Sandbox, Code Quality, and Sidebar entries (requires Python 3 and `pi`). It checks Sidebar tabs, the unavailable-sandbox recovery state, status, reload, and shutdown with Quality disabled and no container definition. It does not certify live language-server diagnostics or shared host servers. Protocol regressions use local synthetic servers and do not require nested Podman or private host-installed language servers. Package tests extract the tarball, load the extension through Pi, and launch the packed broker with existing declared dependencies. See the repository's compatibility notes for the fixture layout and remaining platform limits.


Tested with Pi 1.3.0; host-provided packages use `*` peer ranges. The `quality_response` tool is model-only: it remains available to the main model but cannot be called from codemode or other tools. Load after Devcontainer Sandbox. Run `bun run --cwd code-quality test` and `typecheck`; root `bun run check` includes packaging and integration tests. Synthetic DRY judgment calibration is opt-in through `bun run --cwd code-quality calibrate:dry --confirm-provider-calls`; it sends only versioned synthetic fixtures, does not benchmark latency, and has not been run automatically. No comparison test installs a separate copy of jscpd. Live readability calibration is opt-in through `bun run --cwd code-quality calibrate` and requires an explicitly configured model; it incurs provider costs. Its scope-regression fixtures include unused imports, formatter-owned layout, readable code with a functional bug, partial assertions, changed UI expectations, and generation-guarded cleanup. Deterministic tests verify grouping, complete hunk coverage, proposal boundaries, and the isolated prompt; they do not measure a model's false-positive rate. Run `/reload` after policy/prompt changes so active sessions use the new instructions.
