# Pi Progress Observer

A globally loaded Pi extension that watches long-running TUI sessions with a separate model and publishes concise inferred progress to Sidebar's Summary tab. It does not steer, pause, or add messages to the primary agent conversation.

## Behavior

- Refresh after completed verification commands, failed tool results, clarification tools, and final agent settlement. Milestones debounce for 750 ms and skip an already-observed session revision.
- Verification detection recognizes common `bash` test/check/build commands; it is a cadence heuristic, not proof that a check succeeded.
- Four-turn cadence remains a fallback. After the first refresh, two minutes of age can also trigger an update at the next turn boundary.
- At most one observer request runs at once; additional triggers coalesce into one refresh using the newest session snapshot.
- Summaries are memory-only. Resume, fork, reload, and tree navigation clear stale state and regenerate from the active branch.
- Print, JSON, and RPC sessions do not call the observer model because the result is a TUI presentation feature.

Commands:

```text
/observer [on|off|refresh]
/observer-model [provider/model]
```

## Global configuration

The optional file is:

`~/.pi/agent/extensions/progress-observer/config.json`

An absent file uses these defaults:

```json
{
  "provider": "litellm",
  "model": "amod-gpt-5.6-luna",
  "enabledByDefault": true,
  "timeoutMs": 20000,
  "turnInterval": 4,
  "maxAgeMs": 120000
}
```

Configuration is strict. A malformed file disables requests and publishes an unavailable state; it never interrupts the primary agent.

## Privacy, cost, and interpretation

Each refresh is an additional model call and is not part of the primary agent's normal response usage display. The original user request and recent user constraints from the active branch, compaction/branch summaries, recent visible user/assistant text, tool metadata, and tool-result excerpts can be sent to the configured observer provider. Excerpts retain both the beginning and end of long text; failed results get a larger excerpt budget. A successful observation records its session entry boundary so later inputs distinguish new activity from earlier context. If compaction removes that boundary, the observer reassesses state without claiming a delta. Inputs remain bounded to 24,000 characters and use best-effort redaction for credential-like keys and common secret shapes, but redaction cannot guarantee that arbitrary sensitive text is removed. Choose the provider accordingly.

The sidebar is an **inference from the visible session record**, not the worker model's hidden reasoning and not proof that work is correct or complete. On timeout, malformed output, or provider failure, the previous successful inference remains visible as stale and the main agent continues unaffected.

When the observer provider is exactly `litellm`, refreshes share the LiteLLM log session `pi-<encoded Pi session ID>-activity` via `x-litellm-trace-id`, separate from the main model and other auxiliary flows. Resume, reload, and `/tree` retain the group; new sessions, forks, and clones get new groups. This does not change SDK routing/cache IDs or send prior summaries as a shared server-side conversation. Other providers and aliases are unchanged; existing logs are not migrated.

## Supervision brief

The summary answers what a human needs to supervise, rather than repeating tool activity:

- **Goal** — stable overall user objective.
- **Attention** — relevant unresolved failure, uncertainty, verification gap, or human decision.
- **Now** — specific current problem or actual state after the run ends.
- **Changed** — meaningful results since the previous observation; omitted when no delta is established. The first observation can report concrete results so far.
- **Approach** — a visibly stated decision and reason, or an explicitly labeled plan; never inferred motives.
- **Verified** — actual check outcomes and their limits, not a generic tool-success claim.
- **Next** — a stated next step or verification owed for changes.

Only Goal is required. Unsupported rows are omitted, unchanged supported wording is retained, and resolved attention items are removed. Concise uncertainty and negative facts are allowed when supported; omitted context is not proof that a check never ran. Reasoning/thinking blocks and images remain excluded.

```text
Goal      Prevent duplicate notifications after reload
Attention Reload behavior needs manual verification
Now       Notification ownership moved to session lifecycle
Changed   Removed the second notification subscriber
Approach  Centralize ownership to avoid duplicate registration
Verified  Focused tests pass; full suite not run
Next      Exercise reload manually
```

Sidebar shows the last successful observation time and retains it when a failed update leaves the brief stale. These claims remain model inferences, not a correctness certification. The in-memory event protocol is version 2; reload Observer and Sidebar together when updating.

The design follows long-running-agent guidance favoring concise, externally inspectable progress state over raw logs or chain-of-thought:

- [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Addy Osmani: Long-running agents](https://addyosmani.com/blog/long-running-agents/)
