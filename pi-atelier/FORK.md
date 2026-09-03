# Pi Atelier personal fork

This directory is a manually maintained, source-owned workspace in the `pi-extensions` monorepo. The root package manifest loads its entry point after Permission System. It is intentionally **not** a nested Git checkout and must not be replaced wholesale without reconciling the changes below.

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
cannot include text from the other pane. The Sidebar renders the complete Activity history; its
contained `ScrollView` owns clipping and wheel scrolling rather than dropping rows to fit the viewport.

### 2. Independent Progress and Activity regions

Primary files:

- `src/sidebar.ts`
- `src/split-pane.ts`
- `extensions/index.ts`

The right pane consumes replayable, structurally validated `progress-observer:*` events without importing or owning the observer. The layout assigns explicit equal heights to inferred summary and activity content around a one-row separator, each in its own contained `ScrollView`. A fixed left rail spans the full pane and a fixed horizontal divider separates the independently scrolling regions. State is memory-only and invalid/stale producer events cannot cross session lifecycle boundaries.

**Invariant:** keep Progress explicitly labeled as inferred state and Activity as direct runtime evidence. The observer must remain a separate extension loaded before Atelier. Preserve equal region allocation, fixed non-scrolling dividers, independent scrolling, pane-local selection, and the 44/28-column width behavior.

### 3. Responsive native telemetry footer

Primary files:

- `src/footer.ts`
- `extensions/index.ts`
- footer/split/extension tests

Atelier's registered footer is a single-line Nerd Font overview for auto mode, Plan, thinking level,
model state, Git churn, context, usage, performance, alerts, and external contribution summaries. It remains in
Pi's native dock while the Activity Sidebar is presented. The existing guarded Pi 0.84 adapter only
owns the transcript/sidebar split and leaves unknown layouts untouched.

**Invariant:** keep the overview in Pi's supported native footer and do not relocate editor/footer
components during high-frequency renders. The private fullscreen adapter owns only the horizontal
transcript/sidebar split.

### 4. Native Plannotator phase/progress summary

Primary files:

- `src/plannotator.ts`
- `extensions/index.ts`
- Plannotator and extension tests

The fork owns `plannotator:progress`, reconstructing the active branch's durable Plannotator state.
Planning and execution progress are summarized in the footer, which remains visible beside the
Activity region. Running Activity starts with auto/model identity above a connected three-row oval;
from the Paddock view its filled/bold active corner advances Turn 1 bottom-right, Turn 2 top-right,
Turn 3 top-left, and Turn 4 bottom-left. Absolute turn and elapsed time occupy the infield while
run and permission counts occupy the straights. The integration replays `[DONE:n]` markers after the latest execution boundary
and clears only the duplicate `plannotator-progress` widget. Plannotator's status is the second footer
item, immediately after auto mode. It is required and preserved until the final width clamp at
extremely narrow widths.

**Invariant:** paths must resolve through existing ancestors, remain inside `ctx.cwd`, and use Markdown
extensions. Never trust session/tool-call paths directly.

### 5. No Atelier native completion notifications

Primary files:

- deleted `src/completion-notifier.ts`
- `src/types.ts`
- `extensions/index.ts`
- config/extension/package tests and docs

The feature, config key, event subscription, process spawning, and tests are removed. The separate
local `desktop-notifications` extension remains the only desktop notification owner.

### 6. Unified permission activity and auto-mode footer status

Primary files:

- `src/footer.ts`
- `src/types.ts`
- `extensions/index.ts`
- `tests/footer.test.ts`

The source-owned `pi-permission-system/` workspace owns integrated auto mode and publishes bounded `auto-mode:*` state/decision events plus correlated
permission prompt/final-decision events. Atelier joins these events into Activity. Permission decisions are packed into the owning tool row when space permits;
routine allows with the same source/outcome collapse to one counted badge, and only overflow or
exception details consume follow-up rows. The previous `auto-mode:status` contributed sidebar panel
is deliberately not published.

`FooterState.autoModeStatus` carries the compact label. It renders first in the left zone as a
required item with an infinite drop rank, and is filtered out of the ordinary extension-statuses
segment so it is never rendered twice.

**Invariant:** Activity is the only sidebar permission timeline. It must correlate every policy,
auto, guard, and human tool decision by `toolCallId` and preserve every exceptional decision. Deterministic guard events use a distinct
`security` source; model decisions use `auto`; terminal answers use `human`. Classifier and security
requests-to-human share `requestId` and must merge rather than appear twice. Repeated routine allows
may be visually collapsed with a count, but must not be discarded from the activity model. Nerd Font
semantic icons (`nf-md-security`, `nf-md-robot`, and `nf-md-account`) are the sole source labels,
always separated from outcome marks by whitespace; adjacent copy must not repeat words such as
`auto allow` or `policy allow`. Policy, security, auto, and human badges use distinct colors. The
footer shows only the armed auto-mode label; its decision counts remain in Activity. While the sidebar
is hidden, width pressure must never drop the auto-mode footer item: while a
classifier is approving actions on the operator's behalf, that fact has to stay visible.

### 7. Plain activity labels

Primary files:

- `src/state.ts`
- `src/footer.ts`
- `src/sidebar.ts`

Atelier reports only the useful activity state: `READY` or `WORKING`. The upstream randomized,
Maxis-style working phrases are removed from runtime state and both UI surfaces.

**Invariant:** do not reintroduce decorative activity phrase lists or randomized status copy.

### 8. Fixed personal feature set; no configuration or resize UI

Upstream `src/menu.ts` and `src/settings-workspace.ts`, their tests, all shortcuts, display editor,
tool-list editor, model/tool/session actions, and enable/disable flows are removed. The sole command is
`/atelier [on|off|toggle]`. There is no `pi-atelier.json`; Sidebar and footer behavior is fixed in
source. The persistent footer uses a single responsive Nerd Font strip ordered as auto mode, Plan,
required thinking level, model, Git, context, usage/cost/cache, response performance, alerts, and
extension summaries. Session name, branch-entry count, and persistence are not footer content.

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
4. Create a clean copy of the new upstream snapshot outside this directory. Reapply the local
   patches one at a time, preserving their invariants and updating focused tests after each patch.
5. Diff the candidate against both the new upstream snapshot and this local tree. Do not merely copy
   new upstream files over locally modified files.
6. Run the complete verification below and manually validate fullscreen selection, footer switching,
   Plannotator lifecycle, narrow width, reload, and shutdown.
7. Only after success, replace this directory's maintained files, update the baseline/version above,
   update this patch inventory for moved files, and append the reconciliation to `CHANGELOG.md`.

## Verification

From the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd pi-atelier check
bun run --cwd desktop-notifications test
```

Interactive smoke test from a matching Pi installation:

```sh
pi --tui-mode fullscreen
```

Check:

1. transcript and sidebar selection remain pane-local;
2. sidebar show/hide, fixed-width narrow auto-hide, scrolling, `/reload`, and shutdown;
3. one native footer row while the sidebar is shown, hidden, or responsively unavailable;
4. Plannotator idle, planning, denied/resubmitted, executing, completed, `/tree`, and `/resume` states;
5. no Atelier notification control or native notification process; and
6. exactly one `/atelier` command/runtime is loaded.
