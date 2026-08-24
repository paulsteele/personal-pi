# Auto mode

A Claude-Code-style permission classifier for Pi, implemented as an **authorizer chain link** over
[`@gotgenes/pi-permission-system`](https://pi.dev/packages/@gotgenes/pi-permission-system).

When the deterministic permission policy lands on `ask`, a light model reviews the concrete action
and decides `allow` / `deny` (with a teaching reason) / `defer` — instead of interrupting you for
routine work. Deferring falls through to the normal permission prompt.

## Design invariants

1. **The runtime toggle is the sole authority.** The link defers everything while auto mode is off,
   so a stale `authorizerChain` entry in the permission-system config cannot grant authority.
2. **Every uncertainty defers.** Missing config, unresolved model, missing auth, timeout, malformed
   reply, or unknown surface all fall through to a human prompt. Auto mode can only *remove* a
   prompt it is confident about, or *add* a denial.
3. **The permission policy is never rewritten.** This extension only reads the permission-system
   config. Your allow/ask/deny rules stay exactly as you wrote them.

## Enable

Two independent files are involved — the safety policy lives in pi-permission-system, the model
mechanism lives here.

1. Name the link in the **permission-system** config (opt-in; it decides nothing until you do), and
   turn off yolo. Yolo rewrites `ask` → `allow` before the chain runs, which would make auto mode
   inert:

   ```jsonc
   // ~/.pi/agent/extensions/pi-permission-system/config.json
   {
     "yoloMode": false,
     "authorizerChain": ["auto"]
   }
   ```

2. Declare the classifier in **this** extension's config:

   ```jsonc
   // ~/.pi/agent/extensions/auto-mode/config.json
   {
     "provider": "litellm",
     "model": "amod-claude-haiku-4-5",
     "timeoutMs": 5000,
     "enabledByDefault": false,
     "contextUserTurns": 3,
     "environment": { "trustedRoots": [], "trustedRemotes": [], "trustedDomains": [] }
   }
   ```

3. Arm it in a session with `/auto` (or `/auto on` / `/auto off`, or `ctrl+shift+a`).

Use `/auto-model` to pick the classifier model from Pi's available model registry, or pass it
directly as `/auto-model provider/model-id`. The selection is written atomically to the global
`config.json`, takes effect immediately, clears the turn verdict cache, and is shown in Atelier's
Auto Mode panel.

A project override at `<cwd>/.pi/extensions/auto-mode/config.json` is merged over the global file,
and only when Pi reports the project as trusted — an untrusted repository must not be able to point
the classifier at a model it controls or change future manual-mode policy hints.

## Configuration

| Field              | Type       | Default | Description                                                        |
| ------------------ | ---------- | ------- | ------------------------------------------------------------------ |
| `provider`         | `string`   | —       | Model provider, resolved against Pi's registry. Required.          |
| `model`            | `string`   | —       | Model id within that provider. Required.                           |
| `timeoutMs`        | `integer`  | `5000`  | Per-review budget; a timeout defers. 250–60000. Local config uses 20000. |
| `enabledByDefault` | `boolean`  | `false` | Whether a fresh session starts armed.                              |
| `maxDecisionLog`   | `integer`  | `50`    | Decisions retained for the sidebar panel. 1–500.                   |
| `contextUserTurns` | `integer`  | `3`     | Recent user messages given to the classifier. 0–20.                |
| `environment`      | `object`   | empty   | Reserved deterministic hints for future manual-mode policy; ignored by the auto classifier. |

Without `provider` and `model`, the link defers everything — a safe no-op.

## What the classifier sees

The ask's gate-authoritative facts (surface, tool, value, matched rule, and — importantly —
`executedUnit` and `commandContext`, which reveal a command hidden inside a wrapper or a
substitution), plus the working directory, the repo's configured git remotes, and the last few
**user** messages. External paths are evaluated by operation, sensitivity, scope, and consequence;
they are not denied merely for being outside the working directory.

Assistant output is deliberately excluded. Repository content and command output are
attacker-influencable, so feeding the agent's own text back into the safety classifier would let
injected content argue for its own approval. The user-message block is explicitly marked untrusted
data in the system prompt.

For `edit`, auto mode registers a permission-system input formatter that renders the proposed
`oldText`/`newText` replacements as bounded patch-like evidence before execution. It does not read
the filesystem. The preview is marked as untrusted data, capped at 8,000 characters overall, and
budgeted per replacement so one large change cannot hide later replacements. Full shell-command
evidence receives a separate 2,000-character budget so a gated fragment such as `node` or a variable
assignment can be judged together with the enclosing command.

That context is what lets the classifier honor boundaries you state in conversation ("don't push",
"wait until I review") and judge whether an action has escalated beyond what you asked for.

## Path and external-directory authority

The stock permission system caps every authorizer link's `allow` on the `path` and
`external_directory` surfaces down to `defer`. This installation carries a narrow Bun patch that
exempts only the explicitly configured `auto` link from that envelope. The link remains inert while
auto mode is off, and deterministic `deny` rules still block before the authorizer chain runs.

The patch is version-pinned in `~/.pi/agent/npm/package.json` and reapplied by Bun from
`~/.pi/agent/npm/patches/`. When upgrading `@gotgenes/pi-permission-system`, port and test that
patch before changing the exact dependency version.

## Observability

Every handled ask writes one `auto_mode.decision` entry to pi-permission-system's shared review log
(`~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`),
keyed by `requestId` so it joins to the gate's own records:

`requestId`, `surface`, `verdict`, `reason`, `deferReason`, `modelCalled`, `latencyMs`, `cached`, `modelId`.
The classifier is required to explain both `deny` and `defer`; a defer explanation names the missing
fact that requires the operator's decision.

Cheaper detail (`auto_mode.short_circuit`, `auto_mode.model_reply`) goes to the debug log, and only
when pi-permission-system's `debugLog` toggle is on.

Because every reviewed ask leaves a positive record, a misconfiguration that silently defers
everything shows up as a run of `deferReason` entries rather than an empty log.

## Verdict caching

Verdicts are cached per turn, keyed by surface + value + agent + decision evidence, and dropped on
every `turn_start` and on any mode toggle. This stops a loop that runs the same command repeatedly
from paying for a classifier call each time. `defer` is never cached — a human's answer is not ours to remember.

The cache key is length-prefixed rather than delimiter-joined, so a crafted command value cannot
forge a key collision and inherit another action's cached `allow`.

## UI

The extension publishes to the local Atelier fork over its public sidebar-panel protocol, and sets
a Pi extension status. Because the fork's footer collapses while the sidebar is presented, the two
surfaces are naturally exclusive:

- **Sidebar presented** — an `Auto Mode` panel with the mode, selected classifier model,
  allow/deny/asked counts, and recent decisions including denial reasons.
- **Sidebar hidden** — a compact, never-dropped footer item (`⏵⏵ auto 12/1`).

Atelier is optional. Without it, the status alone is used and nothing breaks.

## Development

```sh
bun test                                              # unit tests
../pi-atelier/node_modules/.bin/tsc --noEmit -p tsconfig.json   # typecheck
```
