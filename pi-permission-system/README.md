# Local Pi Permission System

Personal source-owned permission and auto-mode extension for Pi. It is loaded by
`~/.pi/agent/extensions/local/index.ts`, not published to npm, and intentionally diverges from
`@gotgenes/pi-permission-system`.

## What it enforces

- Global `allow` / `ask` / `deny` policy for built-in and generic tools, Bash, paths,
  external directories, and skills.
- POSIX macOS/Linux path aliases and best-effort symlink containment.
- Deterministic blocking of protected credentials while auto mode is armed.
- Fresh, one-shot human authority for known irreversible actions.
- Model review of ordinary `ask` decisions while `/auto` is on.
- Headless deny when an ask cannot reach a human.

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

### Auto settings

The retained configuration scope is deliberately limited to these five behavior controls; there is no
`maxDecisionLog`, debug toggle, prompt-size setting, session grant, YOLO mode, or project override.
Presentation and review-log field limits are fixed in code.

- `provider` and `model`: classifier selected by `/auto-model`.
- `enabledByDefault`: persisted `/auto on|off` state.
- `timeoutMs`: model-call deadline (250–60000 ms); failure safely defers.
- `contextUserTurns`: number of recent user turns supplied as untrusted context (0–20).
- `environment`: up to 100 trusted roots/remotes/domains of at most 200 characters, shown as hints
  only. They cannot override deterministic safety policy.

## Commands and prompts

- `/auto [on|off]` toggles and persists model review.
- `/auto-model [provider/model]` selects and persists the classifier.
- `Ctrl+Shift+A` toggles auto mode.

All human decisions are one-shot and commit on the first selection. With auto off, prompts offer only
`y` approve and `n` deny. With auto on, they offer exactly `y` approve, `a` approve + classifier note,
`n` deny, and `d` deny + classifier note. There is no follow-up confirmation. The selected allow/deny
is authoritative immediately; a cancelled or blank note never retries or changes it. In the TUI, the
prompt restores the upstream-style aligned facts, warning-yellow highlighting for decision-relevant
commands and paths, bounded evidence and edit previews, and `Ctrl+O` expansion for the complete
request. Notes are capped at 500 characters, reconstructed from the active session branch, and bounded
to the newest eight / 2,000 prompt characters. They affect only later classifier calls and never appear
in Activity, agent-facing denial copy, or review JSONL.

## Events and Activity

The fork preserves `permissions:ui_prompt`, `permissions:decision`, `auto-mode:state`, and
`auto-mode:decision` for local Atelier and desktop notifications. Every tool-call prompt and final
decision includes `toolCallId`; request transitions retain `requestId`, so policy, auto, guard, and
human outcomes attach to the owning tool row.

A bounded/redacted review log is always written to (decision values, reasons, and matched patterns;
and note text are retained only as metadata and SHA-256 digests):

`~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`

## Development

```sh
npm install
npm run check
```

See [FORK.md](FORK.md) for provenance, deleted features, invariants, rollback information, and the
selective-update procedure.
