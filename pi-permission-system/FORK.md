# Local Pi permission-system fork

This is a personal, source-owned fork loaded through `~/.pi/agent/extensions/local/index.ts`.
It is deliberately **not** a nested Git checkout and is not intended for npm publication or upstreaming.

## Baseline and rollback

- Upstream package: `@gotgenes/pi-permission-system` `26.3.1`
- Upstream tag: `pi-permission-system-v26.3.1`
- Upstream commit: `f949977106b55ed04022267a31c5304fccb40ab8` (2026-08-19)
- Imported hardening: staged source delta from
  `~/personal/pi-permission-hardening-1787657399/packages/pi-permission-system/`
- Previous Bun patch: 1,751 lines, SHA-256
  `3af10853adf950ed7c00a85fd3e7ba4681d2965617ca8bab4e5caa97f112840e`
- Rollback snapshot: `~/personal/pi-permission-fork-rollback-20260825-105440`
  (the current pointer remains in `~/plans/.pi-permission-fork-rollback-path`). It contains the
  pre-cutover configs, manifests/lock, patch, staged hardening delta, extension trees, checksums,
  provenance, and recorded green baselines — never copied review logs or secrets.

Pre-migration green baselines were permission system **146 files / 3,189 tests**,
auto mode **141 tests**, Atelier **12 files / 222 tests**, and patch harness **4 tests**.

## Product boundary

### Retained

- One strict, operator-global allow/ask/deny policy, including global skill rules.
- Bash, path, external-directory, built-in file tool, generic tool, skill invocation, and skill-file-read gates.
- POSIX macOS/Linux path normalization, canonical aliases, symlink-boundary checks, native Bash parsing, and fixed Pi/agent read roots.
- Deterministic sensitive-path and irreversible-action safety checks that can require a human but never deny by themselves.
- Integrated allow-or-require-human model classifier, `/auto`, `/auto-model`, and `Ctrl+Shift+A`. The approved retained
  auto configuration is provider/model, persisted state, timeout, user-turn bound, and trusted
  environment hints; prompt/log presentation bounds are fixed.
- One-shot human decisions that commit on the first selection.
- Always-on bounded/redacted review JSONL.
- Prompt/decision and auto Activity events consumed by the local Atelier and desktop notification extensions.

### Deliberately deleted

- YOLO and every blanket ask-to-allow rewrite.
- Session approvals/grants and the `s` decision path.
- Windows/MSYS support.
- Public `PermissionsService`, `permissions:ready`, generic authorizer chains, and extension registration APIs.
- Subagent/per-agent behavior, filesystem forwarding, serving registries, and project-specific policy/config.
- MCP server/target policy, shell aliases, custom extractor/formatter registries, generic settings modal/status, debug logging, legacy config migration, and OpenCode compatibility material. Generic
  structured inputs are still safety-inspected without a tool-family exception.

## Invariants

1. A deterministic guard can require a fresh human but can never grant or deny by itself.
2. Policy deny wins before model or human escalation.
3. Sensitive access and known high-impact work always require one-shot human approval; headless operation blocks.
4. The classifier can only allow or require a human. Timeout/unavailability/malformed replies/failure require a human with UI or block headlessly; external cancellation never creates a stale prompt.
5. Every tool-call prompt and final decision carries `toolCallId`; every request transition retains `requestId`.
6. Permission requests and human outcomes are versioned, durable, non-context transcript entries; the compact decision controls do not replace the thread.
7. Classifier notes are separate versioned non-context session entries. They influence later model review only, never guards/policy, and their text never enters Activity, transcript requests, or JSONL.
8. Activity and permission UI share provenance glyphs: `󰚩` classifier, `󰀄` human, and `󰒃` security/policy.
9. There is exactly one local permission/auto owner at runtime.

## Selective upstream adoption

Do not rebase. To inspect a newer upstream change, clone upstream into a temporary workspace, diff its package against the recorded commit, identify a self-contained behavior worth adopting, and port it manually with local tests. Re-check every invariant above; upstream APIs/features listed as deleted must not reappear incidentally.

## Local verification

```sh
npm install
npm run check
```

Also run the Atelier check and manually test startup, `/reload`, `/auto`, a policy allow, a model allow, a human deny, a deterministic guard, notes, and headless mode.
