#!/usr/bin/env bash
set -eu

address="${1:-}"
case "$address" in
  0x[0-9a-fA-F]*) ;;
  *) exit 2 ;;
esac

# Reject partial matches such as 0x12;command.
if ! printf '%s' "$address" | grep -Eq '^0x[0-9a-fA-F]+$'; then
  exit 2
fi

# Hyprland's Lua configuration API requires a dispatcher expression rather
# than the legacy `focuswindow address:...` dispatcher syntax.
exec hyprctl dispatch "hl.dsp.focus({ window = \"address:$address\" })"
