# Local Pi Atelier fork

A source-owned local Pi extension for this Pi installation. See [`FORK.md`](FORK.md) before reconciling upstream.

## Features

- Fullscreen sidebar implemented as a real layout pane
- Pane-local transcript and sidebar text selection
- Responsive sidebar with `Ctrl+Shift+R` resizing
- Agent, activity, context, workspace, and usage panels
- Native Plannotator planning and execution progress
- Zero-height footer while the sidebar is presented
- Full responsive status rail while the sidebar is hidden
- No settings UI, notifications, telemetry, or external requests

## Loading

`~/.pi/agent/extensions/local/index.ts` imports this fork directly. Do not also install or configure `npm:pi-atelier`; that would load duplicate UI owners and commands.

## Use

```text
/atelier                    # toggle sidebar
/atelier on|off|toggle      # explicit visibility action
```

The sidebar starts visible and hides when the terminal is too narrow. Press `Ctrl+Shift+R` to resize it. In fullscreen mode, scroll over the sidebar to browse every panel independently of the transcript. The layout and behavior are intentionally defined in source rather than user configuration.

Plannotator progress appears in the sidebar during planning and execution. Pi supports one custom footer at a time; this extension owns it, renders zero rows while the sidebar is presented, and restores the fallback status rail when the sidebar is hidden.

## Privacy

The extension does not collect telemetry, store prompts or responses, or implement desktop notifications. It uses read-only Git inspection for workspace status and does not read untracked file contents. The separate local `desktop-notifications` extension owns notifications.

## Development

```bash
cd ~/.pi/agent/extensions/local/pi-atelier
npm install
npm run check
```

## License

MIT
