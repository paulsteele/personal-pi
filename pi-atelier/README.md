# Pi Atelier personal fork

A source-owned personal Pi extension distributed in the `pi-extensions` monorepo. Read [`FORK.md`](FORK.md) before reconciling upstream.

## Features

- Fullscreen-only sidebar implemented as a real layout pane
- Pane-local transcript and sidebar text selection
- Fixed responsive sizing: 44-column preferred width, shrinking to 28 columns before auto-hide below 92 terminal columns
- Activity-only sidebar for run state, response performance, auto-mode decisions, tool history, and permission provenance
- Single-line Nerd Font footer for Agent, model, Git, session, context, usage, Plan, alerts, and external contribution summaries
- Policy, auto-mode, and human permission outcomes packed into tool rows with spaced Nerd Font badges, counted routine allows, and exception-only detail rows
- Namespaced external panel contributions through Atelier's bounded event protocol
- Native persistent footer alongside the fullscreen activity sidebar
- Responsive telemetry priorities that preserve activity, context, active Plan, and armed auto mode under width pressure
- No settings UI, Atelier notifications, telemetry, configuration file, resize mode, or external requests

## Loading

The root `pi-extensions` manifest loads `pi-atelier/extensions/index.ts` after Permission System. Do not also install or configure `npm:pi-atelier`; that would load duplicate UI owners and commands.

## Use

```text
/atelier                    # toggle sidebar
/atelier on|off|toggle      # explicit visibility action
```

The sidebar starts visible in Pi's fullscreen TUI and hides when the terminal is too narrow. It is intentionally dedicated to Activity: run status and performance appear first, followed by auto-mode state, tool history, and permission provenance. Scroll over it independently of the transcript when history exceeds the viewport.

The persistent footer is the overview surface. A single responsive Nerd Font strip summarizes Agent/model state, Git churn, session identity, context, usage, Plannotator, alerts, and external contributions. The footer remains in Pi’s native dock; the Sidebar continues to fail closed on unknown layouts. Layout and behavior are intentionally fixed in source rather than user configuration.

## Privacy

The extension does not collect telemetry, store prompts or responses, or implement desktop notifications. It uses read-only Git inspection for workspace status and does not read untracked file contents. The separate `desktop-notifications` workspace owns notifications.

## Development

From the repository root:

```bash
bun install --frozen-lockfile
bun run --cwd pi-atelier check
bun run --cwd desktop-notifications test
```

## License

MIT
