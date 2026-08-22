# Local Pi Atelier fork

A source-owned personal Pi extension for this installation. Read [`FORK.md`](FORK.md) before reconciling upstream.

## Features

- Fullscreen-only sidebar implemented as a real layout pane
- Pane-local transcript and sidebar text selection
- Fixed responsive sizing: 44-column preferred width, shrinking to 28 columns before auto-hide below 92 terminal columns
- Plannotator, Agent, Activity/tool history, Alerts, Context, Workspace/Git/session, and Usage panels
- Namespaced external panel contributions through Atelier's bounded event protocol
- Zero-height footer while the sidebar is presented
- Dense responsive status rail while the sidebar is hidden, including response performance
- No settings UI, Atelier notifications, telemetry, configuration file, resize mode, or external requests

## Loading

`~/.pi/agent/extensions/local/index.ts` imports this fork directly. Do not also install or configure `npm:pi-atelier`; that would load duplicate UI owners and commands.

## Use

```text
/atelier                    # toggle sidebar
/atelier on|off|toggle      # explicit visibility action
```

The sidebar starts visible in Pi's fullscreen TUI and hides when the terminal is too narrow. Scroll over the sidebar to browse every panel independently of the transcript. Layout and behavior are intentionally fixed in source rather than user configuration.

Plannotator progress appears during planning and execution. Pi supports one custom footer at a time; this extension owns it, renders zero rows while its fullscreen sidebar is presented, and restores the fallback status rail when hidden. Regular and unknown renderers fail closed without layout mutation or overlay presentation.

## Privacy

The extension does not collect telemetry, store prompts or responses, or implement desktop notifications. It uses read-only Git inspection for workspace status and does not read untracked file contents. The separate local `desktop-notifications` extension owns notifications.

## Development

```bash
cd ~/.pi/agent/extensions/local/pi-atelier
npm ci
npm run check
bun test ../desktop-notifications/core.test.ts
```

## License

MIT
