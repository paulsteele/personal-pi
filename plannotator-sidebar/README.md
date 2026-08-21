# Plannotator progress for Pi Atelier

Shows Plannotator's active execution checklist in Pi Atelier's right sidebar and removes the duplicate above-editor `plannotator-progress` widget.

## Data and behavior

- Reads only the active Pi session branch and Plannotator's submitted Markdown plan.
- Mirrors Plannotator's own restore rules: the latest `plannotator` state entry selects the executing plan, and assistant `[DONE:n]` markers after `plannotator-execute` complete steps.
- Publishes `plannotator:progress` through Atelier's `pi-atelier:sidebar-panels` v1 event protocol.
- Does not register a second todo tool, modify the plan, or alter model instructions.
- Hides the panel outside Plannotator execution or when the plan cannot be read safely.

## Configuration

`~/.pi/agent/settings.json` must include `npm:pi-atelier@0.8.2`.

`~/.pi/agent/pi-atelier.json` enables the contributed panel:

```json
{
  "completionNotifications": false,
  "sidebarPanelLayout": [
    { "id": "plannotator:progress", "visible": true }
  ]
}
```

The actual config keeps Atelier's built-in panels too. Its built-in `todos` panel is hidden because Plannotator does not produce a normal `todo` tool result.

Atelier and `pi-open-tui` both provide a custom footer. The current package order loads Atelier first and `pi-open-tui` last, preserving the existing `pi-open-tui` footer. If that UI is no longer wanted, remove `npm:pi-open-tui`; the sidebar bridge does not depend on it.

## Controls

- `/atelier sidebar` — toggle the sidebar
- `/atelier sidebar on|off` — explicitly show or hide it
- `Ctrl+Shift+R` — resize it; arrows adjust, Enter accepts, Escape cancels
- `/atelier display` — reorder or show/hide panels

The sidebar appears when the terminal can preserve Atelier's minimum main and sidebar widths. On narrower terminals, Plannotator's compact footer status remains available.

Run `/reload` after changing extension code or configuration.

## Tests

```bash
bun test ~/.pi/agent/extensions/local/plannotator-sidebar/core.test.ts
```
