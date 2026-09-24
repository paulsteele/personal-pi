# Code Quality

An interactive, post-edit human-readability gate. The main agent and isolated reviewer receive the same readability preferences as enforced requirements. The reviewer assesses exact changes and returns `approved` or `needs_work`. A rejection must identify the preference violated by the changed content and propose a bounded edit addressing that readability problem. A readability violation does not need to cause a functional defect. The reviewer cannot browse the repository, run commands, or change files.

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

## Review and arbitration

The gate waits at the end of an assistant's edit/write batch. Changes to one file coalesce. A rejected batch opens one case; the main agent has five response-and-review rounds after the initial rejection. A response can be a code correction or a bounded disagreement submitted to the reviewer; both use the same counter. Read-only investigation, tests, and infrastructure retries do not consume rounds. Unrelated edit/write targets are blocked until resolution; extra helper/test targets require user-confirmed scope expansion.

The agent uses `quality_response` to disagree or request scope. A disagreement returns to the reviewer at the batch boundary rather than immediately interrupting the operator. The reviewer can approve the existing code or return fresh readability feedback. Automatic operator arbitration occurs only after five completed response-and-review rounds remain unresolved; approval on round five closes the case normally. A premature attempt to finish while feedback is unresolved requests reconsideration and consumes one round only when the reviewer responds, rather than escalating early.

At the limit, the terminal panel offers:

- **Accept original:** approve the current agent-written snapshot, not an earlier version.
- **Accept proposed:** approve the reviewer's exact patch. The main agent applies it through ordinary permission-checked tools; closure requires the resulting hashes to match.
- **Allow another five cycles:** continue with five additional response-and-review rounds, preserving the counter and case notes.

Use ↑/↓ to select a choice, then Enter to resolve it immediately without notes. Press `n` instead to add optional multiline, case-only notes; Enter saves the notes and resolves that choice without another confirmation. Shift+Enter inserts a newline. Escape from either view leaves the case unresolved. The panel shows both rationales and a scrollable current/proposed diff. User approval is final for the selected content; it is recorded separately from model approval.

Infrastructure errors allow five total attempts with 2/4/6/8-second waits between them. Each attempt has its own timeout. Exhaustion pauses for retry, model selection, or an explicit user waiver. Cancellation never means approval. These failure/configuration prompts, content-authorization and scope-expansion prompts, and ordinary permissions remain separate from the five-round readability exchange. The operator can still explicitly invoke `/quality resolve` to intervene sooner; the agent cannot self-approve or use it as an automatic early escalation.

## Compact review log

Each review pass displays `Checking Quality...`, followed by `approved` or `handling rejection N`. Rejection numbering starts at 1 for the initial rejection and advances with unresolved response-and-review rounds. Retries and file groups within one pass do not add checking lines. Explicit waivers remain labeled `waived`, not `approved`.

Collapsed feedback entries show only the short label. Expand an entry to inspect case IDs, snapshot details, rationale, and proposed edits; the executing agent still receives the full feedback. The checking line is presentation-only and is not added to model context.

## Atelier status

Atelier shows `󰅴 quality · provider/model` directly beneath its auto-mode header and above the Activity track. The icon and configured reviewer identify the gate; outcomes appear inline on the corresponding tool rows, not in this header.

Each corresponding edit/write entry has an inline `󰅴` badge beside its permission badges: `✓` for approval, `✕` for needs-work/blocked, `?` for pending review or intervention, and a dim `–` for skipped/unreviewed states. Colors match the classifier: model approval is purple, user approval cyan, negative outcomes red, and pending outcomes amber. There is no separate quality row; detailed state and counters remain in `/quality status` and the review feedback. Calls reviewed together share the batch result without adding model requests. Starting a correction batch preserves the previous batch's result rather than rewriting its history.

Atelier consumes bounded, session-scoped `code-quality:status` and `code-quality:activity` events. No code, rationale, or case snapshots are sent through these presentation events. The header replays for late consumers; per-call display history is memory-only and clears on reload or branch changes. Gate recovery remains independent of the sidebar.

## Coverage and policy

Covers explicit `edit` and `write` tools in **TUI sessions only**. Print/JSON/RPC are explicitly inactive. Shell scripts, formatters, arbitrary custom tools, and independent subagents are not comprehensively detected. Hash checks invalidate observed changes to tracked files, but are not a lock against external editors.

All edited text is eligible, with purpose-aware treatment of source, tests, documentation and configuration. Findings concern names, meaningful structure, explanatory comments, self-describing contracts, and how tests communicate scenarios and expectations. Unused imports/variables, formatting, lint, suspected bugs, missing error handling, coverage, assertion exhaustiveness, performance, security, and API compatibility are outside the review—even when a concern is valid. The formatter owns mechanical layout. Changing an assertion is not grounds for demanding that previous behavior be restored.

The canonical rules are in [policy.md](policy.md), with calibrated contrasts in [examples.md](examples.md). They remain requirements, not advisory preferences. Without this extension, the policy can be copied into your personal AGENTS.md; the extension itself does not modify global instruction files.

Known generated and lock filenames in `exclusions.ts` auto-approve without body capture or model calls. Receipts distinguish `auto_approved`/`reviewed: false` from a model verdict. Exclusions do not bypass ordinary permissions or make failed tools succeed. Binary/non-UTF-8 content is explicitly not reviewed. Sensitive, external, or over-budget content requires a user decision; never silently truncate changed hunks and claim complete review.

A style approval is not a correctness/security certification. Unapproved code has already been written when assessed. Keep ordinary tests and PR review, especially after structural changes.

## Privacy and persistence

The configured provider receives policy/examples, exact changed hunks plus bounded surrounding code, and any case notes. Hunks from the same file are grouped into one request when they fit the input budget, retaining every changed hunk and its original line numbers. Larger files split only at hunk boundaries; each group declares its included and total changed-hunk counts. These remain excerpts, not a claim that the entire file is visible. The reviewer must use all supplied hunks together and not infer missing code from omitted context.

The reviewer does not receive the requested task or main-agent conversation. A submitted disagreement is a separate, bounded argument (at most 2,000 characters), not hidden reasoning, policy, or operator authority. Each review call uses fresh isolated context, current code, prior findings, and the latest submitted disagreement when applicable. User notes remain distinct and authoritative for the case. Code changes or a stale snapshot clear the old disagreement so it is not applied to a different revision. The reviewer still assesses readability independently of the requested behavior change. Best-effort secret detection cannot guarantee detection of arbitrary sensitive data. Sensitive paths and detected secret shapes require authorization; authorization is scoped to the case/provider.

Pending case snapshots/proposals are private files under `~/.pi/agent/extensions/code-quality/cases/`, outside the workspace, with restrictive permissions. Session entries hold content-addressed references and decision metadata. Reload, resume, fork, and tree navigation restore active-branch state and revalidate current files. Missing/corrupt state pauses rather than silently passing. Source-bearing snapshots are retained for recovery; no automatic pruning is currently performed. Do not share session/runtime data without reviewing it.

Model-call usage, latency and retries are recorded as extension metadata, not fabricated into the main model's token totals. Pass receipts display `approved`; rejection receipts display `handling rejection N`. Full feedback is available by expanding the entry. A premature streamed “done” does not override a pending gate.

## Development

Requires Pi 0.87.x, tested with 0.87.1. Load after Permission System. Run `bun run --cwd code-quality test` and `typecheck`; root `bun run check` includes packaging and integration tests. Live calibration is opt-in through `bun run --cwd code-quality calibrate` and requires an explicitly configured model; it incurs provider costs. Its scope-regression fixtures include unused imports, formatter-owned layout, readable code with a functional bug, partial assertions, changed UI expectations, and generation-guarded cleanup. Deterministic tests verify grouping, complete hunk coverage, proposal boundaries, and the isolated prompt; they do not measure a model's false-positive rate. Run `/reload` after policy/prompt changes so active sessions use the new instructions.
