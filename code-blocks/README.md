# Copyable code blocks

A local Pi extension that improves fenced code blocks in assistant messages.

## Features

- Rounded code panels with language labels
- Existing Pi syntax highlighting is preserved
- A clickable `Copy` control on each panel in Pi fullscreen mode
- `/copy-code` opens a keyboard-accessible fallback picker
- `/copy-code 2` copies the second block directly
- If the latest reply has one block, the fallback command copies it without opening a picker

The transformation is display-only. It does not alter session content or the Markdown sent to the model.

## Usage

The extension is auto-discovered from:

```text
~/.pi/agent/extensions/local/index.ts
~/.pi/agent/extensions/local/code-blocks/index.ts
```

The parent `local/index.ts` imports this plugin. Add future personal plugins as sibling subdirectories and register them from that same entry point.

Run `/reload` in an existing Pi session, or restart Pi.
