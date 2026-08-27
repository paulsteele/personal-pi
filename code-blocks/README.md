# Copyable code blocks

A Pi extension that improves fenced code blocks in assistant messages.

## Features

- Rounded code panels with language labels
- Existing Pi syntax highlighting is preserved
- A clickable `Copy` control on each panel in Pi fullscreen mode
- `/copy-code` opens a keyboard-accessible fallback picker
- `/copy-code 2` copies the second block directly
- If the latest reply has one block, the fallback command copies it without opening a picker

The transformation is display-only. It does not alter session content or the Markdown sent to the model.

## Usage

The root `pi-extensions` package loads `code-blocks/index.ts` as an individual extension entry. Run `/reload` in an existing Pi session, or restart Pi after an update.

## Tests

From the repository root:

```sh
bun run --cwd code-blocks test
```
