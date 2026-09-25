# Pi Extensions

Personal Pi extensions maintained as a single versioned monorepo. The repository is one Pi git package, but each extension has its own workspace package and entry point.

## Extensions and load order

Pi loads the entries in this deliberate order:

1. `claude-skills` — exposes trusted project `.claude/skills` directories.
2. `code-blocks` — renders copyable fenced code blocks.
3. `desktop-notifications` — provides actionable terminal-window notifications.
4. `pi-permission-system` — source-owned permission and auto-mode fork.
5. `code-quality` — isolated post-edit style gate with bounded corrections and human arbitration.
6. `progress-observer` — passive side-model progress inference.
7. `pr-review` — code-owned reviews with private generated repo context and Plannotator findings.
8. `pi-atelier` — source-owned fullscreen sidebar/footer fork.

Permission System and Progress Observer load before Atelier so their replayable event state is available when Atelier subscribes. Desktop Notifications remains the sole notification owner.

## Install

After the public repository and release tag exist:

```sh
pi install https://github.com/paulsteele/personal-pi@v1.4.1
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

Checks are local by design; this repository does not use GitHub Actions. All workspaces target Pi 0.87.x and are tested with the Pi 0.87.1 packages.

```sh
bun install --frozen-lockfile
bun run check
```

Focused commands:

```sh
bun run test:custom
bun run test:integration
bun run test:packages
bun run typecheck
bun run lint
bun run format:check
bun run check:pack
```

## Releases

The repository and all eight workspace packages share one version.

1. Start from a clean `main` checkout.
2. Run `bun install --frozen-lockfile && bun run check`.
3. Update the root/workspace versions and changelogs as appropriate.
4. Commit the release.
5. Create an immutable annotated tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
6. Push `main` and the tag.
7. Update the pinned repository tag in dotfiles and run `pi update --extensions`.

Do not move or replace a published version tag.

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

Source and dependencies live in Pi's managed git checkout. Runtime Permission System policy and logs remain outside it:

- config: `~/.pi/agent/extensions/pi-permission-system/config.json`
- logs: `~/.pi/agent/extensions/pi-permission-system/logs/`
- code quality config: `~/.pi/agent/extensions/code-quality/config.json` (select the reviewer with `/quality-model`; no default model)
- progress observer config: `~/.pi/agent/extensions/progress-observer/config.json`
- PR review settings/profiles/reports: `~/.pi/agent/extensions/pr-review/`

PR review methodology and personal-global rules are versioned here in `pr-review/prompts/`; only generated repo semantics and runtime settings live in Pi config. Run `/pr setup` to create a private context draft, inspect it, then run `/pr setup approve` to activate it before the first review. Use `/pr model` to choose the independent model and `/pr` to review changes. Existing approved context is reused; `/pr setup regenerate` explicitly creates a replacement draft that also requires inspection and `/pr setup approve`. Verified findings open in the already-loaded Plannotator UI without a version allowlist; submitted feedback goes to the main agent without a second fix-selection screen. The harness never installs or updates Plannotator. See [`pr-review/README.md`](pr-review/README.md) for compatibility, privacy, scope, and verification details.

The Code Quality gate injects its versioned clarity policy and reviews explicit edit/write batches in interactive sessions. Configure its independent reviewer with `/quality-model`. It pauses unrelated work while feedback is unresolved. Corrections and bounded disagreements return to the reviewer, sharing five response-and-review rounds before automatic terminal arbitration. Known generated/lock filenames auto-approve without model review. See [`code-quality/README.md`](code-quality/README.md) for coverage, privacy, controls, and recovery. It does not replace tests, permissions, or PR review.

The Progress Observer uses a separate model to infer goal/progress/current/next state for Atelier's upper sidebar pane. It is TUI-only, memory-only, never injects into the main agent conversation, and degrades without interrupting work. See [`progress-observer/README.md`](progress-observer/README.md) for cadence, commands, privacy, and cost details.

The Hammerspoon bridge remains machine configuration in the dotfiles repository under `~/.hammerspoon/`; it is not packaged here.

## Provenance and license

Original repository code is MIT licensed; see [`LICENSE`](LICENSE). The `pi-atelier` and `pi-permission-system` directories are source-owned forks with their own retained MIT license and detailed upstream provenance in each `FORK.md`.
