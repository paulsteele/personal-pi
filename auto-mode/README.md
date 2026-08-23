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
   reply, capped surface, or unknown surface all fall through to a human prompt. Auto mode can only
   *remove* a prompt it is confident about, or *add* a denial.
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

That context is what lets the classifier honor boundaries you state in conversation ("don't push",
"wait until I review") and judge whether an action has escalated beyond what you asked for.

## The capped surfaces

pi-permission-system caps any chain link's `allow` on the `path` and `external_directory` surfaces
down to `defer` (its bounded-delegation checkpoint). Auto mode mirrors that cap locally and
short-circuits those asks *before* paying for a model call.

In practice this is narrow. Because a `path` rule that resolves to `allow` makes the `path` gate
skip entirely, ordinary in-project file work reaches the allow-capable per-tool surface
(`write`, `edit`, `read`) and *is* auto-decidable. What stays human-gated is exactly what should:
paths matching an explicit `deny` rule (such as `*.env`) and genuine out-of-working-directory
access.

## Observability

Every handled ask writes one `auto_mode.decision` entry to pi-permission-system's shared review log
(`~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`),
keyed by `requestId` so it joins to the gate's own records:

`requestId`, `surface`, `verdict`, `deferReason`, `modelCalled`, `latencyMs`, `cached`, `modelId`.

Cheaper detail (`auto_mode.short_circuit`, `auto_mode.model_reply`) goes to the debug log, and only
when pi-permission-system's `debugLog` toggle is on.

Because every reviewed ask leaves a positive record, a misconfiguration that silently defers
everything shows up as a run of `deferReason` entries rather than an empty log.

## Verdict caching

Verdicts are cached per turn, keyed by surface + value + agent, and dropped on every `turn_start`
and on any mode toggle. This stops a loop that runs the same command repeatedly from paying for a
classifier call each time. `defer` is never cached — a human's answer is not ours to remember.

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
