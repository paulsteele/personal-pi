# Sidebar

Fullscreen Sidebar and native status footer for Pi. The root package loads `pi-sidebar/extensions/index.ts` once, after sandbox, quality, and Progress Observer extensions.

## Layout

The sidebar uses a 44-column preferred width, shrinks to 28 columns, and hides when the terminal is too narrow (below 92 columns). The status/quality headers and turn/performance indicator are pinned at the top. Click the tab selectors beneath them to choose:

- **Tools** — live tool calls, durations, permission provenance, and inline quality badges. This is the default tab.
- **Summary** — Progress Observer status and model, with spaced Now, Next, Blockers, Goal, and Done sections and wrapped, indented values.
- **Sandbox** — colored state and separate Runtime, Configuration, Bind Mounts, Network, and Attention sections. Writable/read-only mounts have distinct colors; long paths wrap without hiding their details.
- **Settings** — one clickable root per plugin that opens its centered PR-style menu. Accepted field edits save immediately, with no Apply button. Tab selectors wrap at narrow pane widths.

Each tab has independent scrolling. The native footer remains visible separately. Unknown layouts fail closed rather than replacing the transcript with an overlay. Selecting a tab or hiding Sidebar never changes sandbox authority.

## Commands

```text
/sidebar on|off|toggle
/sidebar tools|summary|sandbox|settings
/plugin-settings [section-id]
```

The pane starts visible in fullscreen TUI mode unless its private startup preferences say otherwise. Commands provide a keyboard-accessible tab switch without taking editor or transcript focus. Mouse selection stays local to the active pane.

## Plugin settings

Click a plugin in Settings, or use `/plugin-settings` for keyboard navigation. Sandbox contains General Settings, Project Host Commands, global/project Container Bases and Tools, and Project Environment. Code Quality contains Review Settings and Language Servers. PR Review, Progress Observer, and Sidebar retain their own roots. Loaded third-party npm packages add Web Access, Plannotator (Viewer Settings and Phases), and Questionnaire.

Each child section retains its own loader and validated save operation; entering or leaving a plugin submenu does not load or save every child. Existing direct section IDs such as `/plugin-settings host-commands` remain available.

Menus and field editors share the frame and overlay presenter used by PR Review. Simple fields use choices or text input; complex provider routes, LSP routes, environment recipes, and phase profiles open fullscreen `$EDITOR`. Save and quit to return to Settings and publish the edit; quitting without saving leaves the value unchanged, and unsuccessful editor exits discard the edit. Web settings group extraction, network, credentials, and curator options into submenus. JSON editors are an advanced path, not a schema-complete wizard for every nested third-party option.

Each accepted edit is validated and saved immediately. Choices save on selection and single-line input saves on Enter. Back only navigates; cancelled or invalid field edits preserve the saved value. No Apply, Done, or confirmation button authorizes a configuration edit. The effect message distinguishes immediate runtime changes from changes adopted on the next review, reload, or rebuild.

LSP edits still validate before activation, without a second confirmation. Settings-based LSP wizards, PR profile editors, and generated container-base editors activate/publish on accepted edits rather than requiring another approval command. Sandbox rebuilds, host mounts, and PR source disclosure retain their independent authorization. A pending quality case must be resolved before Settings can disable the gate; editing preferences does not implicitly waive a case.

The host-command add/remove menu saves each accepted addition or removal immediately. That edit is the user authorization; no Done, Apply, or second host-execution prompt is shown. Merely opening Settings does not grant authority.

Settings are available while the agent is idle. Permission prompts, new agent work, branch changes, shutdown, and reload retire an open settings interaction. No settings tool is registered for the model. Existing credential values are hidden and are never resolved or prefilled into replacement editors. Changes to third-party files preserve unrelated keys and require reload for full adoption; adapters validate exposed primitive types, while the third-party package remains responsible for nested configuration semantics. Environment-variable overrides and trusted project-local Plannotator profiles retain their precedence.

Sidebar preferences live at `getAgentDir()/extensions/pi-sidebar/config.json`:

```json
{ "visible": true, "tab": "tools" }
```

Plugins contribute their own `SettingsSection` through the internal `@paulsteele/pi-shared-ui` workspace. The discovery protocol carries trusted host callbacks; it is separate from presentation-only event snapshots and is not a model API. Third-party adapters are maintained in `src/third-party-settings.ts`; they do not patch or import third-party runtime code.

## Integration and privacy

Sidebar consumes bounded `sandbox:state:v1`, `permissions:*`, `code-quality:*`, and `progress-observer:*` events. It does not call models, store source contents, or grant mounts. Sandbox control stays with the trusted host broker. Workspace Git pulse inspection runs through the sandbox execution service.

Structured external panel contributions use `pi-sidebar:sidebar-panels`; the package retains the bounded contribution API. Desktop Notifications is the sole notification owner. See `FORK.md` for retained upstream provenance and `LICENSE` for copyright.

## Development

```sh
bun run --cwd pi-sidebar check
```
