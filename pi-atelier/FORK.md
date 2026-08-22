# Local Pi Atelier fork

This directory is a manually maintained, source-owned fork loaded from
`~/.pi/agent/extensions/local/index.ts`. It is intentionally **not** a nested Git checkout and must
not be replaced wholesale without reconciling the changes below.

## Upstream baseline

- Repository: `https://github.com/michaelmjhhhh/pi-atelier.git`
- Release tag: `v0.8.2`
- Peeled commit: `159f34cf440c18cba847999a191b252b4574b57d`
- Original package version: `0.8.2`
- Local package version: `0.8.2-local.2`
- Pi/TUI target used by this fork: `0.84.2`

The local copy retains only runtime source, tests, build configuration, the package lock, license,
and concise local maintenance docs. Upstream agent/Claude skills, contributor workflow, research/demo
assets, `.git`, and `node_modules` are intentionally excluded.

## Local patch inventory

### 1. A real fullscreen sidebar pane

Primary files:

- `src/split-pane.ts`
- `src/sidebar.ts`
- `tests/split-pane.test.ts`

In the supported fullscreen Pi 0.84 renderer, the right side is a real `HStack` child containing a
non-primary, contained `ScrollView`. The passive overlay remains only as an invisible lifecycle/theme
acquisition seam. Regular and unknown renderers fail closed without layout mutation or overlay
presentation. Width is fixed at 44 preferred/28 minimum columns, with a 64-column main-pane minimum
and auto-hide below 92 terminal columns.

**Invariant:** fullscreen mouse selection begins in either the transcript or sidebar `ScrollView` and
cannot include text from the other pane. The Sidebar renders its complete panel stack; its contained
`ScrollView` owns clipping and wheel scrolling rather than dropping panels to fit the viewport.

### 2. Responsive zero-height footer

Primary files:

- `src/split-pane.ts`
- `src/footer.ts`
- `extensions/index.ts`
- footer/split/extension tests

While the sidebar is actually presented, Atelier's registered footer renders no lines. In fullscreen,
a guarded Pi 0.84 layout-node adapter also changes the known footer stack entry's `minSize` from one
to zero and restores it when the sidebar hides, the renderer is unsupported, or Atelier disposes.
When the sidebar is manually or responsively hidden, the complete Atelier rail returns.

**Invariant:** never guess at an unfamiliar Pi layout. The footer-slot adapter requires the exact
Pi 0.84 root/dock `VStack` shape and otherwise leaves layout untouched.

### 3. Native Plannotator phase/progress panel

Primary files:

- `src/plannotator.ts`
- `extensions/index.ts`
- Plannotator and extension tests

The fork owns `plannotator:progress`, reconstructing the active branch's durable Plannotator state.
Planning displays its mode and a validated known plan path; execution displays checklist progress and
replays `[DONE:n]` markers after the latest execution boundary. It clears only the duplicate
`plannotator-progress` widget. When the sidebar is absent, Plannotator's status is a required Atelier
footer item and cannot be dropped by responsive pressure.

**Invariant:** paths must resolve through existing ancestors, remain inside `ctx.cwd`, and use Markdown
extensions. Never trust session/tool-call paths directly.

### 4. No Atelier native completion notifications

Primary files:

- deleted `src/completion-notifier.ts`
- `src/types.ts`
- `extensions/index.ts`
- config/extension/package tests and docs

The feature, config key, event subscription, process spawning, and tests are removed. The separate
local `desktop-notifications` extension remains the only desktop notification owner.

### 5. Fixed personal feature set; no configuration or resize UI

Upstream `src/menu.ts` and `src/settings-workspace.ts`, their tests, all shortcuts, display editor,
tool-list editor, model/tool/session actions, and enable/disable flows are removed. The sole command is
`/atelier [on|off|toggle]`. There is no `pi-atelier.json`; Sidebar and footer behavior is fixed in
source. The fallback footer always includes activity, model/thinking, Git, extension statuses,
usage/cost/cache, response performance, and context, subject only to responsive dropping.

## Reconcile a future upstream release

Use a temporary workspace; do not turn this directory into a nested Git repository.

1. Read this file and the current local tests before changing anything.
2. Clone both baselines:

   ```sh
   work=$(mktemp -d)
   git clone https://github.com/michaelmjhhhh/pi-atelier.git "$work/upstream"
   git -C "$work/upstream" worktree add "$work/old" 159f34cf440c18cba847999a191b252b4574b57d
   git -C "$work/upstream" worktree add "$work/new" <new-tag-or-commit>
   git -C "$work/upstream" diff --stat 159f34cf440c18cba847999a191b252b4574b57d..<new-ref>
   ```

3. Inspect upstream changes overlapping every file in the patch inventory. Pay special attention to:
   - Pi renderer compatibility and private adapter guards;
   - overlay and selection behavior;
   - fixed-width sidebar lifecycle and responsive cleanup;
   - footer ownership and layout structure;
   - panel registry protocol changes;
   - completion-notification code being reintroduced by upstream copies.
4. Create a clean copy of the new upstream snapshot outside this directory. Reapply the four local
   patches one at a time, preserving their invariants and updating focused tests after each patch.
5. Diff the candidate against both the new upstream snapshot and this local tree. Do not merely copy
   new upstream files over locally modified files.
6. Run the complete verification below and manually validate fullscreen selection, footer switching,
   Plannotator lifecycle, narrow width, reload, and shutdown.
7. Only after success, replace this directory's maintained files, update the baseline/version above,
   update this patch inventory for moved files, and append the reconciliation to `CHANGELOG.md`.

## Verification

From this directory:

```sh
npm install
npm run check
bun test ../desktop-notifications/core.test.ts
```

Interactive smoke test from a matching Pi installation:

```sh
pi --tui-mode fullscreen
```

Check:

1. transcript and sidebar selection remain pane-local;
2. sidebar show/hide, fixed-width narrow auto-hide, scrolling, `/reload`, and shutdown;
3. zero footer rows while the sidebar is presented and full fallback footer otherwise;
4. Plannotator idle, planning, denied/resubmitted, executing, completed, `/tree`, and `/resume` states;
5. no Atelier notification control or native notification process; and
6. exactly one `/atelier` command/runtime is loaded.
