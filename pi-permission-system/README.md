# Pi Permission System personal fork

Personal source-owned permission and auto-mode extension for Pi. The root `pi-extensions` manifest loads this workspace before Atelier. It is not published to npm and intentionally diverges from `@gotgenes/pi-permission-system`.

## What it enforces

- Global `allow` / `ask` / `deny` policy for built-in and generic tools, Bash, paths,
  external directories, and skills.
- POSIX macOS/Linux path aliases and best-effort symlink containment.
- Deterministic detection of protected credentials and known irreversible actions; positive matches always require fresh, one-shot human approval.
- Model review of ordinary `ask` decisions while `/auto` is on. The classifier may auto-approve or request a human, but never deny an action by itself.
- Headless deny when an ask cannot reach a human.
- Classifier review for unresolved path-bearing shell expansions while auto mode is armed; manual mode still asks the operator, and deterministic sensitive-path or high-impact guards remain human-only.

This is a decision layer, not a sandbox. Allowed tools still have the authority Pi gives them.

## Global configuration

Only one config exists:

`~/.pi/agent/extensions/pi-permission-system/config.json`

```json
{
  "permission": {
    "*": "ask",
    "path": { "*": "allow", "*.env": "deny" },
    "read": "allow",
    "bash": { "git status": "allow", "git diff": "allow" },
    "external_directory": "ask",
    "skill": "ask"
  },
  "auto": {
    "provider": "litellm",
    "model": "amod-gpt-5.6-luna",
    "enabledByDefault": true,
    "timeoutMs": 20000,
    "contextUserTurns": 3,
    "environment": {
      "trustedRoots": [],
      "trustedRemotes": [],
      "trustedDomains": []
    }
  }
}
```

Project, per-agent, shell-alias, MCP-target, session-grant, and YOLO configuration is unsupported
and rejected. Policy uses last matching rule wins inside a surface map.

The sensitive-path guard does not treat the exact `.env.example` basename (case-insensitive)
as credentials merely because of its name. It still applies ordinary path/tool policy and checks
credential directories and resolved symlink targets, including dangling destinations for writes. To allow templates while denying other env
files, order path rules as `"*.env": "deny"`, `"*.env.*": "deny"`, then `"*.env.example": "allow"`.
Other `.env.*` names remain sensitive; allow rules do not bypass other deterministic guards.

### Live updates and existing approvals

The shared tool gate rereads this file at permission/action boundaries, including after an awaited
classifier or human answer. Rule edits and `/auto` changes apply without `/reload` or restarting a PR
review. Invalid, missing, or unreadable config blocks source/tool actions rather than silently retaining
old permissions. Config refresh does not reset session grants, notes, counters, or event subscriptions.
An already executing command/provider request cannot be recalled.

The existing turn-local cache of **classifier allows** is retained. Current deterministic rules/guards
run before cache lookup, and changed policy, auto settings, action/context facts or notes invalidate
reuse. This is not a cache of human approvals. Existing configured allows, explicit session-directory
grants and exact session-file grants remain supported; none overrides a deterministic deny or guard.

### Auto settings

The retained configuration scope is deliberately limited to these five behavior controls; there is no
`maxDecisionLog`, debug toggle, prompt-size setting, session grant, YOLO mode, or project override.
Presentation and review-log field limits are fixed in code.

- `provider` and `model`: classifier selected by `/auto-model`.
- `enabledByDefault`: persisted `/auto on|off` state.
- `timeoutMs`: deadline for the complete classifier operation (250–60000 ms), including up to two malformed-response repair attempts; timeout requests human approval or blocks headlessly.
- `contextUserTurns`: number of recent user turns supplied as authoritative task context (0–20). User instructions define the requested goal and may authorize crossing ordinary permission boundaries; repository, command, web, and proposed-edit content cannot expand that authority.
- `environment`: up to 100 trusted roots/remotes/domains of at most 200 characters, shown as hints
  only. They cannot override deterministic safety policy.

### File-modification authorization

For `edit` and `write`, the classifier reviews the operation, target/resolved paths, and user task
context—not replacement text or file contents. Bodies are intentionally omitted; their absence alone
is not a reason to request human approval. Approval authorizes modifying the file, not the safety or
correctness of the resulting code. A path-only review cannot distinguish legitimate and malicious
changes to the same authorized file.

Bounded edit previews remain available in human approval prompts. Explicit user restrictions, path
policy, resolved-destination checks, and deterministic sensitive-file guards still apply. Bash commands
continue to include command evidence; this does not turn shell review into path-only authorization.

### `/tmp` logs in auto mode

Only `external_directory` reviews whose normalized display path is `/tmp` or a descendant and whose
resolved destination remains within the canonical `/tmp` root receive additional risk-based log guidance.
The platform's root alias (normally `/tmp` → `/private/tmp` on macOS) is resolved before containment is
checked. The classifier also receives the selected path's resolved destination. For those accesses, narrow reads/searches of task-related logs and captured
output, and ordinary scratch-log creation/appends, may be approved without the user explicitly naming
the file. Missing proof of log creation alone is not a reason to escalate an otherwise low-risk access.

Other paths do not receive this exception, including `/private/tmp`, `/var/tmp`,
macOS per-user temp directories, and project-local scratch directories. There is no general relaxation
of diagnostic authorization. Other paths and operations in mixed commands retain their normal review.

This is classifier guidance, **not a `/tmp` allowlist or an ownership guarantee**. It reviews the whole
command and data flow for credentials, unrelated/other users' data, broad harvesting, symlink escapes,
destructive writes, suspicious execution/persistence, and uploads. The exception does not extend to
symlink destinations outside `/tmp`. Explicit user restrictions, policy denies, and deterministic
human-only safety guards still apply. Manual mode and classifier failure/headless fallback behavior
are unchanged.

## Commands and prompts

- `/auto [on|off]` toggles and persists model review.
- `/auto-model [provider/model]` selects and persists the classifier.
- `Ctrl+Shift+A` toggles auto mode.

All human decisions commit on the first selection. Ordinary manual and deterministic security
requests offer `y` approve once and `n` deny. External-directory policy prompts also offer `p` allow
directory for session; that choice grants the canonical directory and its descendants in memory until
the current Pi session ends, without modifying global configuration. Classifier-triggered requests
additionally offer `a` approve + classifier note and `d` deny + classifier note. There is no follow-up
confirmation. A cancelled or blank note never retries or changes the selected decision. Before execution,
newer policy and cancellation still apply: an answer to a stale request is superseded and the action is
re-evaluated, not executed under old rules.

In the TUI, each bounded permission request is appended as a durable, non-context transcript entry;
a compact `󰀄 Human decision` panel contains only the choices. The full thread therefore remains
scrollable with Pi's normal fullscreen keys, mouse wheel, search, and selection while approval is
pending. After selection, a correlated `󰀄` outcome entry remains beside the request across reload and
branch navigation. `Ctrl+O` expands the recorded request through Pi's normal transcript behavior.
Classifier requests use `󰚩 ? → 󰀄`; deterministic security requests use `󰒃 ? → 󰀄`.

Notes are capped at 500 characters, reconstructed from the active session branch, and bounded to the
newest eight / 2,000 prompt characters. They affect only later classifier calls and never appear in
Activity, agent-facing denial copy, transcript request/outcome entries, or review JSONL.

## Delegated PR permissions

The loaded extension owns the versioned, in-process `permissions:review-service:v1` service. PR capture,
worker tools, inline source, and source-derived transfers use the same `tool-review.ts` evaluator as the
main agent. There is no second policy file, bundled engine, public model tool, or general subagent runtime.

Each worker has its own turn-local classifier cache; a new turn/retry or relevant live context change
invalidates it. Host preparation and pre-turn input work do not retain such verdicts. Human approvals are
one-shot; parent directory/file grants are not silently inherited by children. PR remains snapshot-only
and read-only regardless of a classifier's answer. Deterministic source/path denies and human-only guards
cannot be overridden by a tool-level allow. Paths are shown to the classifier even when a tool-level ask
wins policy selection; oversized path previews require human review instead of hiding scope.

The trusted PR host has a separate local-search check: ordinary repository-contained source can be scanned
without resolving `ask` rules, but explicit denies and deterministic sensitive-path guards block scanning
without opening a prompt. This check is available only to delegated tasks with read/search capabilities;
it is not a model-tool argument or a disclosure grant. The host must authorize matching content through the
normal read gate before returning it. No-match files do not become continuing context dependencies.
Audit decisions distinguish `local_search_allowed` and `local_search_blocked` from disclosure approvals.

Requests include the genuine parent user intent or actual `/pr` invocation, separately labeled delegated
assignment metadata, worker identity, original source paths, and an explicit cancellation signal. Protected
file contents are not sent to the classifier merely to ask whether they may be read. A shared FIFO queue
serializes main/child human dialogs; cancelling a queued request cannot open a stale prompt. Reload,
session replacement and tree navigation retire old delegated operations.

## Events and Activity

The fork preserves `permissions:ui_prompt`, `permissions:decision`, `auto-mode:state`, and
`auto-mode:decision` for local Atelier and desktop notifications. Every tool-call prompt and final
decision includes `toolCallId`; request transitions retain `requestId`, so policy, auto, guard, and
human outcomes attach to the owning tool row. Delegated identity is separate from the outer tool ID:
`pr_review` activity attaches to its actual parent row, while slash-command requests are standalone.
`permissions:review_state` supplies queued/showing/finished transitions for PR's task dashboard.

Trusted extensions can emit `permissions:allow_session_files` with
`{ version: 1, sessionId: ctx.sessionManager.getSessionId(), paths: [absoluteFilePath] }`.
The listener accepts 1–100 existing regular files for the active session and grants only their exact
canonical destinations at the `external_directory` boundary. It does not grant parent directories,
descendants, or wildcard matches. A malformed batch or a different session ID is ignored. This is an
in-process extension API, not authority inferred from model text, tool results, or persisted messages.

PR review uses this event for its saved report before command/tool handoff. Grants live only in memory
and are cleared on shutdown/session replacement and `/reload`; they are not restored from history or
written to configuration. All tool/Bash/path rules, explicit denies, and deterministic safety guards
still apply. This is a boundary allowance, **not a read-only sandbox or authorization to apply fixes**.

A bounded/redacted review log is always written to (decision values, reasons, and matched patterns;
and note text are retained only as metadata and SHA-256 digests):

`~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`

## Development

From the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd pi-permission-system check
```

See [FORK.md](FORK.md) for provenance, deleted features, invariants, rollback information, and the
selective-update procedure.
