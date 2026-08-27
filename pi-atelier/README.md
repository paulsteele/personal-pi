# Pi Atelier personal fork

A source-owned personal Pi extension distributed in the `pi-extensions` monorepo. Read [`FORK.md`](FORK.md) before reconciling upstream.

## Features

- Fullscreen-only sidebar implemented as a real layout pane
- Pane-local transcript and sidebar text selection
- Fixed responsive sizing: 44-column preferred width, shrinking to 28 columns before auto-hide below 92 terminal columns
- Plannotator, Agent, unified Activity/tool-and-permission history, Alerts, Context, Workspace/Git/session, and Usage panels
- Policy, auto-mode, and human permission outcomes packed into tool rows with spaced Nerd Font badges, counted routine allows, and exception-only detail rows
- Namespaced external panel contributions through Atelier's bounded event protocol
- Zero-height footer while the sidebar is presented
- Dense responsive status rail while the sidebar is hidden, including response performance
- No settings UI, Atelier notifications, telemetry, configuration file, resize mode, or external requests

## Loading

The root `pi-extensions` manifest loads `pi-atelier/extensions/index.ts` after Permission System. Do not also install or configure `npm:pi-atelier`; that would load duplicate UI owners and commands.

## Use

```text
/atelier                    # toggle sidebar
/atelier on|off|toggle      # explicit visibility action
```

The sidebar starts visible in Pi's fullscreen TUI and hides when the terminal is too narrow. Scroll over the sidebar to browse every panel independently of the transcript. Layout and behavior are intentionally fixed in source rather than user configuration.

Plannotator progress appears during planning and execution. Auto mode contributes state and per-request classifier observations to Activity; the permission system contributes final policy/human outcomes. Pi supports one custom footer at a time; this extension owns it, renders zero rows while its fullscreen sidebar is presented, and restores the fallback status rail when hidden. Regular and unknown renderers fail closed without layout mutation or overlay presentation.

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
