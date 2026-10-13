# Shared UI

Internal workspace for the PR dashboard and plugin Settings tab. It is not a Pi extension and registers no model tools or slash commands.

- `createPanelFrame` supplies the PR-style opaque frame, selection fill, and width-aware padding.
- `presentPanel` owns centered overlay mounting, completion, cancellation, and deferred cleanup without closing an unrelated approval UI.
- `chooseMenu` and `inputPanel` provide keyboard/mouse menu navigation and framed single-line field editing.
- `editConfigDraft` (also exposed as `editorPanel`) opens JSON/multiline drafts in fullscreen `$EDITOR`, falling back to `$VISUAL` and then `vi`. Save and quit to return to Settings and immediately publish the accepted field edit; there is no Apply button. Quitting without saving leaves the field unchanged; a nonzero editor exit discards the field. Drafts use private temporary files that are removed on return.
- `openConfigFile` opens an existing configuration file directly in the same fullscreen editor. Saving changes that file immediately; setup drafts still need their owning plugin's explicit approval to become active. Editor commands may include arguments or quoted executable paths. GUI editors need a wait flag (for example, `EDITOR='code --wait'`).
- External editors suspend Pi's terminal rendering and input, restoring the harness when they exit or fail. Cancelling a workflow terminates its editor and discards temporary draft changes.
- `registerSettingsSection` contributes a plugin-owned loader, editable fields, validated save operation, and optional setup actions over `pi-settings:discover:v1`. Discovery carries executable host callbacks, not a model-callable permission service.
- `groupPluginSettings` groups sections with a shared plugin descriptor into one navigation root, preserving their individual loaders and save operations.
- `openSettingsSection` opens plugin submenus and saves each accepted edit through the owning section's `apply` callback immediately. Choices save on selection, text saves on Enter, and JSON/multiline values save when the external editor exits successfully. Back only navigates; cancelled or invalid edits do not publish. Unchanged fields do not save unless their defaults still need initial publication. Merely opening a section never writes configuration. Owner validators enforce schemas and stale-write checks; successful edits reload the section before the next edit.
- Settings setup actions that edit configuration publish on editor return without a second approval button. Rebuilds, host mounts, source disclosure, and pending-quality case resolution remain distinct operations.
- `fileSettingsDraft` preserves unrelated keys, rejects symlinked paths and external changes, and publishes a private replacement file. Third-party adapters use this rather than importing their executable implementation modules.

Sensitive fields display only whether they are configured. Replacement editing starts blank and never resolves credential commands or copies an existing secret into the editor. Sensitive user-entered replacements are still terminal input and stored in the owning plugin's config; use environment references when possible.

Settings are idle-TUI-only. Shutdown, branch changes, new agent work, and permission prompts retire active settings interactions. No draft or configuration values are added to model context or session transcripts. A plugin's own setup action may make a model call or post its normal setup messages; the menu cannot bypass that plugin's source permissions or approvals.

```sh
bun run --cwd shared-ui test
bun run --cwd shared-ui typecheck
```
