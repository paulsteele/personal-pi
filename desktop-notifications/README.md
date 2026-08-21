# Pi desktop notifications

Actionable, bounded notifications for Pi running in Alacritty:

- **macOS:** Hammerspoon native notifications and exact-window routing.
- **Linux:** Hyprland window routing with dunst notifications.
- Sends completion notifications only after `agent_settled` and only when the originating terminal is unfocused.
- Sends notifications for actual interactive permission prompts and clears them on the matching decision.
- Keeps at most one notification per terminal window and clears only that window's notice when work resumes—including after submitting a normal response or answering/canceling an in-terminal question. Merely focusing the terminal does not clear it.
- Never uses Hammerspoon's bulk notification clear; notices from other Pi windows and unrelated Hammerspoon automation remain intact.

## macOS setup

1. Install Hammerspoon:

   ```sh
   brew install --cask hammerspoon
   ```

2. Start Hammerspoon and enable **Launch at Login** in its preferences.
3. Grant Hammerspoon these macOS permissions when prompted:
   - **Privacy & Security → Accessibility** (required to identify/focus the exact Alacritty window)
   - **Notifications** (allow alerts and sounds)
4. Grant Hammerspoon **Automation → Dock** access if macOS prompts for it. This is needed to switch Spaces before focusing an originating window on another Space.
5. The provided `~/.hammerspoon/init.lua` loads `hs.ipc`, installs `/opt/homebrew/bin/hs`, and loads `pi-notify.lua` for notification delivery, exact window discovery, Space switching, and focus.
6. Reload Hammerspoon after config changes, then run `/reload` in Pi.

Preflight:

```sh
hs -c 'return piNotify.preflight()'
```

Expected output includes `"ok":true` and `"accessibility":true`.

Hammerspoon owns notification lifecycle, exact Alacritty window discovery, switching to the window's Space, and click focus. Each terminal window receives a stable key, while each emitted notice receives a unique namespaced tag. Clear, replacement, and click cleanup target only that exact tag; the bridge intentionally has no `clearAll` API or bulk-clear fallback. Existing Claude Code notification settings are unaffected.

### Reload boundary

Do not routinely reload Hammerspoon while actionable notices are visible. Hammerspoon 1.1.1 cannot reliably reconstruct an individually withdrawable `NSUserNotification` object after a configuration/process reload. To protect notices belonging to other Pi windows, startup is deliberately non-destructive: visible pre-reload notices remain for one-time manual dismissal. Notices created after the reload resume normal targeted clear/replacement behavior.

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

### A notice remains after reloading Hammerspoon

Manually dismiss that pre-reload notice once. Startup intentionally does not bulk-clear Notification Center because that would also erase notices belonging to agents in other windows. Fresh notices created after reload are tracked and cleared individually.

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
