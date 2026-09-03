# Pi Extensions

Personal Pi extensions maintained as a single versioned monorepo. The repository is one Pi git package, but each extension has its own workspace package and entry point.

## Extensions and load order

Pi loads the entries in this deliberate order:

1. `claude-skills` — exposes trusted project `.claude/skills` directories.
2. `code-blocks` — renders copyable fenced code blocks.
3. `desktop-notifications` — provides actionable terminal-window notifications.
4. `pi-permission-system` — source-owned permission and auto-mode fork.
5. `progress-observer` — passive side-model progress inference.
6. `pi-atelier` — source-owned fullscreen sidebar/footer fork.

Permission System and Progress Observer load before Atelier so their replayable event state is available when Atelier subscribes. Desktop Notifications remains the sole notification owner.

## Install

After the public repository and release tag exist:

```sh
pi install https://github.com/paulsteele/personal-pi@v1.0.5
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

Trust the checkout when Pi prompts. The committed `.pi/settings.json` disables all six resources from the globally configured release and loads the six local entries in the same order, so development does not create duplicate commands, UI owners, or event subscribers. This override applies only while Pi's working directory is this repository.

## Verification

Checks are local by design; this repository does not use GitHub Actions.

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

The repository and all six workspace packages share one version.

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
- progress observer config: `~/.pi/agent/extensions/progress-observer/config.json`

The Progress Observer uses a separate model to infer goal/progress/current/next state for Atelier's upper sidebar pane. It is TUI-only, memory-only, never injects into the main agent conversation, and degrades without interrupting work. See [`progress-observer/README.md`](progress-observer/README.md) for cadence, commands, privacy, and cost details.

The Hammerspoon bridge remains machine configuration in the dotfiles repository under `~/.hammerspoon/`; it is not packaged here.

## Provenance and license

Original repository code is MIT licensed; see [`LICENSE`](LICENSE). The `pi-atelier` and `pi-permission-system` directories are source-owned forks with their own retained MIT license and detailed upstream provenance in each `FORK.md`.
