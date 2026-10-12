# Shared UI

Internal workspace for the PR dashboard and plugin Settings tab. It is not a Pi extension and registers no model tools or slash commands.

- `createPanelFrame` supplies the PR-style opaque frame, selection fill, and width-aware padding.
- `presentPanel` owns centered overlay mounting, completion, cancellation, and deferred cleanup without closing an unrelated approval UI.
- `chooseMenu`, `inputPanel`, and `editorPanel` provide keyboard/mouse menu navigation and framed field editing. JSON/multiline editors use Ctrl+S to accept and Esc to discard the field.
- `registerSettingsSection` contributes a plugin-owned loader, editable fields, Apply operation, and optional setup actions over `pi-settings:discover:v1`. Discovery carries executable host callbacks, not a model-callable permission service.
- `groupPluginSettings` groups sections with a shared plugin descriptor into one navigation root, preserving their individual loaders and Apply operations.
- `openSettingsSection` opens plugin submenus or retains a leaf section's local draft, applies only after explicit user selection, and offers discard/keep-editing on Back. Owner validators enforce their configuration schemas. Setup actions require a clean draft and keep their existing approval flows.
- `fileSettingsDraft` preserves unrelated keys, rejects symlinked paths and external changes, and publishes a private replacement file. Third-party adapters use this rather than importing their executable implementation modules.

Sensitive fields display only whether they are configured. Replacement editing starts blank and never resolves credential commands or copies an existing secret into the editor. Sensitive user-entered replacements are still terminal input and stored in the owning plugin's config; use environment references when possible.

Settings are idle-TUI-only. Shutdown, branch changes, new agent work, and permission prompts retire active settings interactions. No draft or configuration values are added to model context or session transcripts. A plugin's own setup action may make a model call or post its normal setup messages; the menu cannot bypass that plugin's source permissions or approvals.

```sh
bun run --cwd shared-ui test
bun run --cwd shared-ui typecheck
```
