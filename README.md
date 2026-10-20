# Pi Extensions

Personal Pi extensions maintained as a single versioned monorepo. The repository is one Pi git package, but each extension has its own workspace package and entry point.

## Extensions and load order

Pi loads the entries in this deliberate order:

1. `claude-skills` — exposes trusted project `.claude/skills` directories.
2. `code-blocks` — renders copyable fenced code blocks.
3. `desktop-notifications` — provides actionable terminal-window notifications.
4. `pi-devcontainer-sandbox` — mandatory Podman devcontainer tools and host mount approvals.
5. `code-quality` — post-edit diagnostics, indexed DRY and readability gates with bounded corrections and human arbitration.
6. `progress-observer` — passive side-model progress inference.
7. `pr-review` — code-owned reviews with private generated repo context and Plannotator findings.
8. `pi-sidebar` — fullscreen Sidebar with pinned status/turn headers and Tools, Summary, Sandbox, and Settings tabs.

The non-extension `project-locations` workspace shares worktree-aware profile locations across PR, LSP, and sandbox setup. The non-extension `shared-ui` workspace provides the common PR/settings frame, overlay lifecycle, and plugin-owned settings flows.

Devcontainer Sandbox and Progress Observer load before Sidebar so their replayable event state is available when Sidebar subscribes. Desktop Notifications remains the sole notification owner.

## Install

After the public repository and release tag exist:

```sh
pi install https://github.com/paulsteele/personal-pi@v2.13.0
```

The dotfiles repository normally records the same pinned source in `~/.pi/agent/settings.json`, so Pi installs a missing user package automatically at startup when online. The public HTTPS URL requires no SSH alias or repository credentials.

Run `/reload` after installation or restart Pi. Use `pi list` to confirm the configured source and installed path.

## Development

```sh
git clone https://github.com/paulsteele/personal-pi ~/personal/pi-extensions
cd ~/personal/pi-extensions
bun install
bun run check
pi
```

Trust the checkout when Pi prompts. The committed `.pi/settings.json` disables all eight resources from the globally configured release and loads the eight local entries in the same order, so development does not create duplicate commands, UI owners, or event subscribers. This override applies only while Pi's working directory is this repository.

## Verification

Checks are local by design; this repository does not use GitHub Actions. All workspaces are tested with pinned Pi 1.3.0 development packages. Host-provided Pi packages and TypeBox use `*` peer ranges and are not bundled as runtime dependencies.

```sh
bun install --frozen-lockfile
bun run check
```

Focused commands:

```sh
bun run test:custom
bun run test:integration
bun run test:release
bun run test:packages
bun run typecheck
bun run lint
bun run format:check
bun run check:pack
```

## Releases

The repository and all workspace packages share one version.

1. Start from a clean `main` checkout.
2. Write release notes under `## Unreleased` in the affected workspace changelogs.
3. Preview and apply the version bump:

   ```sh
   bun run bump patch --dry-run
   bun run bump patch
   ```

   Use `minor`, `major`, or an explicit stable version such as `1.6.0` (also accepts `v1.6.0`). The target must be newer than the current version.

   [`scripts/bump-version.ts`](scripts/bump-version.ts) discovers workspaces from the root manifest and updates all package versions, only the corresponding workspace version fields in `bun.lock`, and the README install pin. It promotes nonempty `## Unreleased` or `## [Unreleased]` sections to the new version with today's UTC date. Empty sections, historical notes, dependency versions, and lockfile resolutions remain unchanged; missing changelogs are not created. Existing version mismatches or a stale README pin stop preparation before any writes.

   Preparation can run on a dirty checkout and preserves unrelated edits, but does not enforce branch or Git state. Review the diff and finish any release notes before proceeding.
4. Run `bun install --frozen-lockfile && bun run check` against the bumped files.
5. Commit the release.
6. Create an immutable annotated tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
7. Push `main` and the tag.
8. Update the pinned repository tag in dotfiles and run `pi update --extensions`.

The bump command only prepares repository files: it never runs checks, commits, tags, pushes, edits dotfiles, or updates Pi. `--dry-run` lists the planned files without writing; `bun run bump --help` shows usage. Do not move or replace a published version tag.

## New-machine setup

1. Install Pi and apply the dotfiles repository.
2. Start Pi while online. The pinned package in `~/.pi/agent/settings.json` is cloned and its dependencies are installed automatically.
3. Run `pi list` and verify `https://github.com/paulsteele/personal-pi@<tag>` appears.
4. Restart Pi or run `/reload` after package reconciliation if a session was already open.

## Update and rollback

To update, change the tag in `~/.pi/agent/settings.json`, then reconcile the managed checkout:

```sh
pi update --extensions
```

To roll back, restore the previous tag in settings and run the same command. Pinned refs do not advance unless settings changes.

## Runtime configuration

Source and dependencies live in Pi's managed git checkout. Runtime Devcontainer Sandbox policy and logs remain outside it:

- config: `~/.pi/agent/extensions/pi-devcontainer-sandbox/config.json`
- global devcontainer: `~/.pi/agent/extensions/pi-devcontainer-sandbox/global/devcontainer.json`
- private project definitions and session authority: `~/.pi/agent/extensions/pi-devcontainer-sandbox/`
- code quality config: `~/.pi/agent/extensions/code-quality/config.json` (select the reviewer with `/quality-model`; no default model)
- progress observer config: `~/.pi/agent/extensions/progress-observer/config.json`
- PR review settings/profiles/reports: `~/.pi/agent/extensions/pr-review/`

Sandbox setup commands:

- `/sandbox setup global` creates a complete fallback base.
- `/sandbox setup global tools` configures shared tooling.
- `/sandbox setup` configures private worktree-shared project requirements.
- `/sandbox setup base` explicitly creates a private base replacement.

All five LSPs are built into reusable tool images and added to the generated devcontainer without modifying repository definitions. Local devcontainer definitions are also supported. Container Base, Sandbox Tools, and Project Environment settings use manual editors; the extension does not generate model proposals. Ask the main agent for configuration help or an approved `request_sandbox_tool` installation. Saved settings take effect on reload/rebuild.

`request_host_mount` asks the operator for more host access. Sandboxing has no off switch or automatic host fallback. Authorize exact scripts or named executables through Settings → Sandbox → Project Host Commands, or by editing the private `host-commands.json` file. Saving the file or accepting an edit in Settings is the authorization; there is no Apply button or separate approval command. Matching invocations run natively with any arguments; the surrounding Bash shell stays in the container. Web and Plannotator package tools also retain their explicitly authorized host execution. See [`pi-devcontainer-sandbox/README.md`](pi-devcontainer-sandbox/README.md) for limits, migration, and setup.

PR review methodology and personal-global rules are versioned here in `pr-review/prompts/`; only generated repo semantics and runtime settings live in Pi config. Run `/pr setup` to create a private context draft, inspect it, then run `/pr setup approve` to activate it before the first review. Use `/pr model` to choose the independent model and `/pr` to review changes. Existing approved context is reused; `/pr setup regenerate` explicitly creates a replacement draft that also requires inspection and `/pr setup approve`. Verified findings open in the already-loaded Plannotator UI without a version allowlist; submitted feedback goes to the main agent without a second fix-selection screen. The harness never installs or updates Plannotator. See [`pr-review/README.md`](pr-review/README.md) for compatibility, privacy, scope, and verification details.

The Code Quality gate checks explicit edit/write batches in interactive sessions, applying its clarity and DRY policies after LSP diagnostics.

Stages run LSP → DRY → readability using one configured quality model. DRY findings cite bounded counterpart evidence without requiring an exact patch. Configure the reviewer with `/quality-model`. Managed jscpd tooling and turn-start background baselines expose readiness and details in Sidebar's Quality tab and DRY Settings. Current edits query one baseline per assistant turn; selected pairs receive fresh judgments. Main-transcript stage lines show live timers and completion durations.

Provisioned LSPs work automatically in trusted projects. `/quality lsp setup` is only for exceptional project overrides and never installs software. Servers execute inside the session devcontainer, with separate sandbox generations using separate servers. All diagnostic severities enter the correction flow before readability review. Quality reviews accessible files without an outside-repository filter and pauses unrelated work while feedback is unresolved. Corrections and bounded disagreements return to the reviewer, sharing five response-and-review rounds before automatic terminal arbitration. Known generated/lock filenames auto-approve without model review.

See [`code-quality/README.md`](code-quality/README.md) for coverage, privacy, controls, and recovery. The gate does not replace tests, permissions, or PR review.

The Progress Observer uses a separate model to infer goal/progress/current/next state for Sidebar's Summary tab. It is TUI-only, memory-only, never injects into the main agent conversation, and degrades without interrupting work. See [`progress-observer/README.md`](progress-observer/README.md) for cadence, commands, privacy, and cost details.

The Hammerspoon bridge remains machine configuration in the dotfiles repository under `~/.hammerspoon/`; it is not packaged here.

## Provenance and license

Original repository code is MIT licensed; see [`LICENSE`](LICENSE). The `pi-sidebar` and `pi-devcontainer-sandbox` directories are source-owned forks with their own retained MIT license and detailed upstream provenance in each `FORK.md`.
