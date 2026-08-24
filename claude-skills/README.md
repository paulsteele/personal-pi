# Project Claude skills

Makes `.claude/skills` directories from the current project and its ancestors available to Pi.
Discovery stops at the nearest Git repository root.

Because loading project skills requires Pi project trust, the extension asks before trusting a
project when Claude skills are present. In non-interactive modes it leaves the decision to Pi's
normal trust policy. Skills are contributed only after the project is trusted.

## Tests

```sh
bun test ~/.pi/agent/extensions/local/claude-skills/index.test.ts
```
