# Pi desktop notifications

Actionable, bounded notifications for Pi running in Alacritty:

- **macOS:** Hammerspoon native notifications and exact `hs.window` routing.
- **Linux:** Hyprland window routing with dunst notifications.
- Sends completion notifications only after `agent_settled` and only when the originating terminal is unfocused.
- Sends notifications for actual interactive permission prompts and clears them on the matching decision.
- Keeps at most one notification per terminal window and clears it when work resumes or the terminal regains focus.

## macOS setup

1. Install Hammerspoon:

   ```sh
   brew install --cask hammerspoon
   ```

2. Start Hammerspoon and enable **Launch at Login** in its preferences.
3. Grant Hammerspoon these macOS permissions when prompted:
   - **Privacy & Security → Accessibility** (required to identify/focus the exact Alacritty window)
   - **Notifications** (allow alerts and sounds)
4. The provided `~/.hammerspoon/init.lua` loads `hs.ipc`, installs `/opt/homebrew/bin/hs`, and loads `pi-notify.lua`.
5. Reload Hammerspoon after config changes, then run `/reload` in Pi.

Preflight:

```sh
hs -c 'return piNotify.preflight()'
```

Expected output includes `"ok":true` and `"accessibility":true`.

Hammerspoon completely replaces `terminal-notifier` for this Pi extension. Existing Claude Code notification settings are unaffected.

## Linux / Hyprland setup

Required:

- Alacritty under Hyprland
- `hyprctl`
- dunst with `dunstify`
- one sound player:
  - preferred: `canberra-gtk-play` (often packaged as `libcanberra`/`libcanberra-gtk3`)
  - fallback: `paplay` plus the freedesktop sound theme

The extension briefly marks the terminal title and resolves the exact client from `hyprctl clients -j`. It listens to Hyprland socket2 `activewindowv2` events and clears the notification when that address regains focus. Notification clicks dispatch:

```sh
hyprctl dispatch focuswindow address:0x...
```

Only validated Hyprland addresses reach the helper. Notification text is never evaluated by a shell.

## Usage

After dependencies and permissions are ready:

1. Run `/reload` in Pi.
2. Switch to another application/window.
3. Run `/notify-test` in Pi. It reports the native target and sends a test notification when the terminal is unfocused.
4. Click the notification and confirm the exact Alacritty window is focused.

Normal behavior:

- Completion title: `Pi · <project>` / `Ready for input`
- Permission title: `Pi · <project>` / `Permission needed: <surface>`
- Body: a normalized, Unicode-safe, bounded excerpt
- Every emitted notification plays a sound.

## Troubleshooting

### `Desktop notifications disabled: grant Hammerspoon Accessibility permission`

Grant Accessibility access, fully quit/reopen Hammerspoon if macOS requires it, verify `piNotify.preflight()`, then `/reload` Pi.

### Hammerspoon notification does not appear

Open **System Settings → Notifications → Hammerspoon**, enable notifications and sounds, then run `/notify-test` while Alacritty is not focused.

### `/notify-test` says the terminal is focused

This is intentional: the extension suppresses notifications while the originating terminal is focused. Switch away, then invoke the command from a queued/RPC input or test with a normal long-running turn and switch away before it settles.

### Hyprland notification does not focus the window

Verify:

```sh
hyprctl clients -j
hyprctl activewindow -j
dunstify --action='default,Open terminal' --wait 'Pi test' 'Click me'
```

Also ensure dunst is configured so a click invokes the default action.

### No Linux sound

Test one of:

```sh
canberra-gtk-play -i complete -d pi-desktop-notify
paplay /usr/share/sounds/freedesktop/stereo/complete.oga
```

### Unsupported environment

The first version intentionally guarantees only:

- macOS + Alacritty + Hammerspoon
- Linux + Alacritty + Hyprland + dunst

It does not fall back to app-level activation because that can navigate to the wrong terminal window.

## Tests

```sh
bun test ~/.pi/agent/extensions/local/desktop-notifications/core.test.ts
```
