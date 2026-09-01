# Pi Progress Observer

A globally loaded Pi extension that watches long-running TUI sessions with a separate model and publishes concise inferred progress to Pi Atelier. It does not steer, pause, or add messages to the primary agent conversation.

## Behavior

- First refresh after the first completed model turn in a session.
- Later refreshes after five additional turns or two minutes, whichever is due at the next turn boundary.
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
  "turnInterval": 5,
  "maxAgeMs": 120000
}
```

Configuration is strict. A malformed file disables requests and publishes an unavailable state; it never interrupts the primary agent.

## Privacy, cost, and interpretation

Each refresh is an additional model call and is not part of the primary agent's normal response usage display. Recent visible user/assistant text, tool metadata, and short tool-result excerpts can be sent to the configured observer provider. Inputs are size-bounded and use best-effort redaction for credential-like keys and common secret shapes, but redaction cannot guarantee that arbitrary sensitive text is removed. Choose the provider accordingly.

The sidebar is an **inference from external evidence**, not the worker model's hidden reasoning and not proof that work is correct or complete. On timeout, malformed output, or provider failure, the previous successful inference remains visible as stale and the main agent continues unaffected.

The design follows long-running-agent guidance favoring concise, externally inspectable progress state over raw logs or chain-of-thought:

- [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Addy Osmani: Long-running agents](https://addyosmani.com/blog/long-running-agents/)
