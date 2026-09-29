# Code Quality

An interactive post-edit quality gate combining optional project-configured LSP diagnostics with isolated human-readability review. The main agent and isolated reviewer receive the same readability preferences as enforced requirements. The reviewer assesses exact changes and returns `approved` or `needs_work`. A rejection must identify the preference violated by the changed content and propose a bounded edit addressing that readability problem. A readability violation does not need to cause a functional defect. The reviewer cannot browse the repository, run commands, or change files.

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
  "maxInputChars": 64000,
  "maxOutputTokens": 8000
}
```

The provider/model values above are placeholders, not defaults. `/quality status` shows current state; `/quality on|off` controls the gate. Disabling a pending gate requires confirmation and records a waiver. `/quality retry` resumes a pending review; `/quality resolve` reopens a proposal decision when one is available. Config changes can be loaded with `/reload`.

## LSP setup and operation

Run `/quality lsp setup` in a trusted project. One checklist shows detected and already configured languages. Toggle languages with Space or Enter, then Continue. Setup reuses existing server configurations, automatically chooses an installed executable or offers a private installation, infers workspace roots, and generates server names. It asks about roots or C# solutions only when there is no single clear choice; one solution is preferred over its constituent projects.

Choose **Validate and enable** to authorize local analysis and activate checking if validation succeeds. There is no second activation prompt. Cancelling, failed validation, or configuration changes during validation leave the active profile unchanged. Existing source diagnostics do not prevent activation, and operational summaries stay out of the main transcript.

**Advanced** contains custom servers, explicit executable paths/root overrides, and editable configuration. Existing environment, settings, and timeout overrides are preserved for languages you keep selected. Deselecting a language removes its routes from the proposed configuration; selecting none disables LSP checking. Setup never installs SDKs, edits project dependencies, or changes shell PATH.

```text
/quality lsp setup                 Language checklist; validate and enable
/quality lsp setup edit            Open a private editable draft
/quality lsp setup approve         Validate and approve that draft
/quality lsp status                Configured servers, states, sharing, failures
/quality lsp doctor [server-id]    Check the real project's diagnostic support
/quality lsp restart [server-id]   Restart a shared server after confirmation
/quality lsp on|off                Enable/disable the project profile
```

Presets are Roslyn for C#, TypeScript/JavaScript, Pyright, rust-analyzer, and gopls. Custom **stdio servers with pull diagnostics** can be configured as well. ReSharper standalone is not supported. The pinned Roslyn package is a prerelease; TypeScript language server requires Node >=22.22.2 independently of Pi's minimum. Rust needs its toolchain and `rust-src`; Go and .NET likewise need their SDKs already installed. Setup explains these prerequisites rather than silently installing them.

Profiles live under `getAgentDir()/extensions/code-quality/repos/<repo-id>/lsp-profile.json` (or `projects/<folder-id>/` for non-Git projects). Git worktrees share configuration using the same common-directory identity algorithm as PR profiles, but distinct worktrees have distinct servers. Roots and C# project/solution paths are relative to the checkout. Non-Git descendants use the closest configured ancestor. Multiple routes at the deepest matching root can check the same file. Edit the private draft to change environment overrides, server settings, roots, extensions, or deadlines; the active file rejects unapproved manual changes.

Missing servers are installed only after confirmation into private `tools/<server>/<version>/<platform-arch>/` directories. These installations are shared across repositories using the same agent directory; each project still requires its own validation and approval. Setup reuses receipt-verified installations without reinstalling. It also discovers executables without a matching receipt in the expected layout, including .NET tools installed directly in the version/platform directory; these are treated as external servers rather than claiming a verified pinned version. Existing installation directories are never overwritten. Installation and configuration publication use locks so concurrent setup cannot expose partial installations or silently overwrite another draft. No configured server means the existing readability workflow continues unchanged.

### Shared server lifecycle

At TUI startup, configured servers warm in the background. Pi instances with the same agent storage, physical workspace, executable/configuration, and relevant environment attach to one local broker and one LSP. Different worktrees or incompatible configurations do not share. The broker owns document versions and reads current disk snapshots; each Pi keeps its own case, correction counter, and operator decisions.

Closing or reloading one Pi releases its connection without stopping other clients. The last client disconnect triggers LSP shutdown and bounded process-group cleanup. A process guard handles broker loss; deliberately detached custom daemons and simultaneous uncatchable termination of broker and guard are outside that guarantee. `/quality lsp restart` affects all attached clients and invalidates pending results. Status reports the shared generation and client count.

Language servers are trusted local processes, **not a sandbox**. They can read dependencies, execute project analyzers/build tooling, restore dependencies, and write caches. The broker inherits selected toolchain/locale/proxy variables plus approved route overrides, not arbitrary Pi session/model variables. The client never applies formatting, code actions, or server-requested edits. File-scoped feedback does not constrain what the analysis process internally reads or executes.

### Diagnostic gate

Successful `edit`/`write` results include a compact diagnostic preview; a diagnostic rejection does not mean the file write failed. At the batch boundary the gate reconciles the final snapshot, runs LSP first, and only invokes the readability model when diagnostics are clear.

**Errors, warnings, information, hints, and unspecified-severity diagnostics all block**, including findings that predate the edit. Their original severity is preserved. Project/server rules and suppressions still determine which diagnostics exist. Findings outside edited files are not added to the case. Unsupported content, unconfigured routes, missing results, and failures are never labeled clean.

LSP findings use the same initial rejection plus five response rounds, scope restrictions, disagreements, and operator arbitration as readability findings. A disagreement reruns LSP; the model cannot dismiss a diagnostic. Without a patch, arbitration offers current code or five more rounds. An exact operator-approved readability patch must still pass LSP afterward. Explicit LSP-only waivers are recorded separately from clean diagnostics.

Server failures pause for retry, reconfiguration, or waiver without consuming correction rounds. Defaults are 60 seconds for startup and 10 seconds per file diagnostic operation, configurable in the draft. A timeout or empty clearing notification is not a pass. File hashes, observed workspace changes, provider registration, and server generations invalidate stale results; these checks are not an atomic filesystem lock.

Scope is macOS/Linux/WSL TUI sessions. The current real-server validation was on macOS arm64; Linux/WSL and larger real-world solutions still need field validation. See [lsp-compatibility.md](lsp-compatibility.md) for pinned versions, protocol quirks, reproducible probes, and measured tiny-fixture latencies. Clean LSP diagnostics are not a full build, test, or correctness certification.

## Review and arbitration

The gate waits at the end of an assistant's edit/write batch. Changes to one file coalesce. A rejected batch opens one case; the main agent has five response-and-review rounds after the initial rejection. A response can be a code correction or a bounded disagreement submitted to the reviewer; both use the same counter. Read-only investigation, tests, and infrastructure retries do not consume rounds. Unrelated edit/write targets are blocked until resolution; extra helper/test targets require user-confirmed scope expansion.

The agent uses `quality_response` to disagree or request scope. A disagreement returns to the reviewer at the batch boundary rather than immediately interrupting the operator. The reviewer can approve the existing code or return fresh readability feedback. Automatic operator arbitration occurs only after five completed response-and-review rounds remain unresolved; approval on round five closes the case normally. A premature attempt to finish while feedback is unresolved requests reconsideration and consumes one round only when the reviewer responds, rather than escalating early.

At the limit, the terminal panel offers:

- **Accept original:** approve the current agent-written snapshot, not an earlier version.
- **Accept proposed:** when a validated readability patch exists, approve it for application through ordinary permission-checked tools. Closure requires exact resulting hashes and resolution of any configured LSP diagnostics.
- **Allow another five cycles:** continue with five additional response-and-review rounds, preserving the counter and case notes.

Use ↑/↓ to select a choice, then Enter to resolve it immediately without notes. Press `n` instead to add optional multiline, case-only notes; Enter saves the notes and resolves that choice without another confirmation. Shift+Enter inserts a newline. Escape from either view leaves the case unresolved. The panel shows source-labeled findings, current code, and a scrollable current/proposed diff when a patch exists. Accepting current code is final for that snapshot and records any outstanding or unrun checks; it is not a model or clean-LSP verdict.

Invalid reviewer submissions, including out-of-scope findings or proposals, get **one immediate repair attempt**, not five identical retries. Every request lists eligible finding lines separately from visible edit-context ranges. The repair receives the validation error and a bounded excerpt of the rejected submission, and must return a fresh complete verdict. A second invalid submission stops for retry, model selection, or an explicit user waiver; it is neither an approval nor a readability rejection. If the repair cannot fit the input/context budget, the gate stops without sending it or truncating reviewed code.

Provider failures have a separate budget: the first four failures wait 2/4/6/8 seconds before retrying, and the fifth stops. Each request has its own timeout. This budget is shared across the initial submission and its repair; transport retries preserve repair feedback and do not grant another repair opportunity. Provider failures and invalid submissions do not consume readability rounds. Cancellation never means approval. These failure/configuration prompts, content-authorization and scope-expansion prompts, and ordinary permissions remain separate from the five-round readability exchange. The operator can still explicitly invoke `/quality resolve` to intervene sooner; the agent cannot self-approve or use it as an automatic early escalation.

## Compact review log

Each review pass displays `Checking Quality...`, followed by `approved` or `handling rejection N`. Rejection numbering starts at 1 for the initial rejection and advances with unresolved response-and-review rounds. Retries and file groups within one pass do not add checking lines. Explicit waivers remain labeled `waived`, not `approved`.

Collapsed feedback entries show only the short label. Expand an entry to inspect case IDs, snapshot details, rationale, and proposed edits; the executing agent still receives the full feedback. The checking line is presentation-only and is not added to model context.

## Atelier status

Atelier shows `󰅴 quality · provider/model` directly beneath its auto-mode header and above the Activity track. Configured LSPs append their names and running state, for example `roslyn ● ready ×2 · typescript ⟳ checking`; entries wrap at narrow widths. The multiplier is the number of attached clients. `ready` means the server is usable, not that all code is clean. Aggregate quality outcomes remain on the corresponding tool rows.

Each corresponding edit/write entry has an inline `󰅴` badge beside its permission badges: `✓` for approval, `✕` for needs-work/blocked, `?` for pending review or intervention, and a dim `–` for skipped/unreviewed states. Colors match the classifier: model approval is purple, user approval cyan, negative outcomes red, and pending outcomes amber. There is no separate quality row; detailed state and counters remain in `/quality status` and the review feedback. Calls reviewed together share the batch result without adding model requests. Starting a correction batch preserves the previous batch's result rather than rewriting its history.

Atelier consumes bounded, session-scoped `code-quality:status` and `code-quality:activity` events. No code, rationale, or case snapshots are sent through these presentation events. The header replays for late consumers; per-call display history is memory-only and clears on reload or branch changes. Gate recovery remains independent of the sidebar.

## Desktop notifications

When the desktop-notifications extension is loaded, quality dialogs notify an unfocused terminal's user through the existing macOS/Hyprland notifier. This covers choosing current/proposed code at arbitration, authorizing file review, recovering a failed review, approving extra correction paths, selecting a reviewer, and confirming a waiver. Routine review and agent-handled rejections stay silent.

The controller brackets each wait with `code-quality:attention` events containing only `version: 1`, session/request IDs, a decision kind, and an `active` boolean. A matching end event, session reset, or shutdown retires the notice. These transient events carry no source, paths, findings, or provider errors, and notification failures cannot approve or block a quality decision.

## Coverage and policy

Covers explicit `edit` and `write` tools in **TUI sessions only**. Print/JSON/RPC are explicitly inactive. Shell scripts, formatters, arbitrary custom tools, and independent subagents are not comprehensively detected. Hash checks invalidate observed changes to tracked files, but are not a lock against external editors.

All edited text is eligible for readability review, with purpose-aware treatment of source, tests, documentation and configuration. The isolated model's findings concern names, meaningful structure, explanatory comments, self-describing contracts, and how tests communicate scenarios and expectations. Unused imports/variables, formatting, lint, suspected bugs, missing error handling, coverage, assertion exhaustiveness, performance, security, and API compatibility are outside the model's readability review—even when a concern is valid. Configured LSP diagnostics are a separate source of findings in the same gate. The formatter owns mechanical layout. Changing an assertion is not grounds for demanding that previous behavior be restored.

The canonical rules are in [policy.md](policy.md), with calibrated contrasts in [examples.md](examples.md). They remain requirements, not advisory preferences. Without this extension, the policy can be copied into your personal AGENTS.md; the extension itself does not modify global instruction files.

Known generated and lock filenames in `exclusions.ts` auto-approve without body capture or model calls. Receipts distinguish `auto_approved`/`reviewed: false` from a model verdict. Exclusions do not bypass ordinary permissions or make failed tools succeed. Binary/non-UTF-8 content is explicitly not reviewed. Sensitive, external, or over-budget content requires a user decision; never silently truncate changed hunks and claim complete review.

A style approval is not a correctness/security certification. Unapproved code has already been written when assessed. Keep ordinary tests and PR review, especially after structural changes.

## Privacy and persistence

The configured provider receives policy/examples, exact changed hunks plus bounded surrounding code, and any case notes. Hunks from the same file are grouped into one request when they fit the input budget, retaining every changed hunk and its original line numbers. Larger files split only at hunk boundaries; each group declares its included and total changed-hunk counts. These remain excerpts, not a claim that the entire file is visible. The reviewer must use all supplied hunks together and not infer missing code from omitted context.

The reviewer does not receive the requested task or main-agent conversation. A submitted disagreement is a separate, bounded argument (at most 2,000 characters), not hidden reasoning, policy, or operator authority. Each review call uses fresh isolated context, current code, prior findings, and the latest submitted disagreement when applicable. User notes remain distinct and authoritative for the case. Code changes or a stale snapshot clear the old disagreement so it is not applied to a different revision. The reviewer still assesses readability independently of the requested behavior change. Best-effort secret detection cannot guarantee detection of arbitrary sensitive data. Sensitive paths and detected secret shapes require authorization; authorization is scoped to the case/provider.

Pending case snapshots/proposals are private files under `~/.pi/agent/extensions/code-quality/cases/`, outside the workspace, with restrictive permissions. Session entries hold content-addressed references and decision metadata. Reload, resume, fork, and tree navigation restore active-branch state and revalidate current files. Missing/corrupt state pauses rather than silently passing. Source-bearing snapshots are retained for recovery; no automatic pruning is currently performed. Do not share session/runtime data without reviewing it.

Model-call usage, latency and retries are recorded as extension metadata, not fabricated into the main model's token totals. Pass receipts display `approved`; rejection receipts display `handling rejection N`. Full feedback is available by expanding the entry. A premature streamed “done” does not override a pending gate.

When the reviewer provider is exactly `litellm`, all quality calls for one Pi session share the LiteLLM log session `pi-<encoded Pi session ID>-quality` via `x-litellm-trace-id`. This includes chunks, retries, validation repairs, corrections, and disagreements across cases. Resume, reload, and `/tree` retain the group; new sessions, forks, and clones get their own groups. Main-model calls remain separate. This is log correlation, not shared conversation context or a change to SDK routing/cache IDs. Other providers and aliases are unchanged; standalone calibration without a Pi owner adds no session header. Existing logs are not migrated.

## Development

Normal tests use fake LSP processes and do not install servers. `bun run --cwd code-quality test:lsp-tui` runs an opt-in two-instance pseudoterminal smoke test with an isolated fake-server profile (requires Python 3 and `pi`). `bun run --cwd code-quality test:lsp-compatibility` explicitly runs the pinned local server probes; `QUALITY_LSP_TOOL_ROOT` selects the private tool directory. Package tests extract the tarball, load the extension through Pi, and launch the packed broker with existing declared dependencies. See the repository's compatibility notes for the fixture layout and remaining platform limits.


Requires Pi 0.87.x, tested with 0.87.1. Load after Permission System. Run `bun run --cwd code-quality test` and `typecheck`; root `bun run check` includes packaging and integration tests. Live calibration is opt-in through `bun run --cwd code-quality calibrate` and requires an explicitly configured model; it incurs provider costs. Its scope-regression fixtures include unused imports, formatter-owned layout, readable code with a functional bug, partial assertions, changed UI expectations, and generation-guarded cleanup. Deterministic tests verify grouping, complete hunk coverage, proposal boundaries, and the isolated prompt; they do not measure a model's false-positive rate. Run `/reload` after policy/prompt changes so active sessions use the new instructions.
