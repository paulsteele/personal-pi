# Changelog

## 2.0.0

- Remove correction-scope approval notifications; additional quality correction files no longer require a separate human decision.

- Connect sandbox authorization requests to desktop notifications before session startup. Retain pending permission notices until terminal resolution completes, and discard them when the matching request is approved, denied, or cancelled.

## 1.5.0 — 2026-09-29

- Add notifications for LSP setup and recovery decisions using the existing quality attention lifecycle, without including source or diagnostic content.

## 1.4.2 — 2026-09-28

- Show quality decision notifications through the existing macOS/Hyprland notifier, with fixed text that excludes source, findings, paths, and provider errors. Clear matching notices when dialogs close or sessions retire, and suppress completion notices while a quality dialog is pending.
