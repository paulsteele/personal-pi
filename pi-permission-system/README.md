# Mandatory devcontainer sandbox

Pi remains on the host, but its built-in file tools, Bash shell, and quality language-server subprocesses execute in a per-session Podman development container. Manually configured project host-command rules can route selected executable invocations to the host. Sandbox failures block guest tool execution; there is no auto mode or automatic host fallback. The only way out is the explicit, session-scoped [escape hatch](#sandbox-off-escape-hatch), which the operator turns on. The explicitly authorized web and Plannotator package tools retain their host execution, as described under Integration. The initial writable bind is the canonical directory where the session starts.

This is tool/process isolation, not whole-Pi isolation. Pi and loaded extensions are trusted host code. Writable binds expose real host files to modification/deletion. Internet access permits uploads. Commands are not screened for sensitive files, external effects, or suspicious shell syntax. The sandbox boundary and explicit policy denies remain enforced, but path/command deny recognition is best-effort rather than secret exclusion from a raw bind.

## Environment definitions

Select one base using the Dev Container Specification and pinned reference CLI. Precedence:

1. Private project definition, shared across Git worktrees by canonical common-directory identity.
2. Local `.devcontainer/devcontainer.json`, `.devcontainer.json`, or a selected `.devcontainer/<name>/devcontainer.json`.
3. Private global default.

Resolved paths are shown by setup/status and Sidebar's Sandbox tab:

- Settings: `~/.pi/agent/extensions/pi-permission-system/config.json`
- Global: `~/.pi/agent/extensions/pi-permission-system/global/devcontainer.json`
- Project: `~/.pi/agent/extensions/pi-permission-system/{repos|projects}/<id>/devcontainer/devcontainer.json`
- Session authority: `~/.pi/agent/extensions/pi-permission-system/sessions/<session-id-hash>/`

The actual agent directory follows `getAgentDir()`/`PI_CODING_AGENT_DIR`. When neither a private project base nor a repository-local definition exists, the global base is used, including everything baked into its image. Project `tools.json` and `project-environment.json` still extend that global base; they do not require a project `devcontainer.json`. An explicit project or local base replaces the global base rather than merging with it. Definitions can reference images or Containerfiles through standard build fields. Features, Compose, unsafe runtime flags, privileged mode, host namespaces/devices, and engine sockets remain rejected.

Three private configuration files extend the selected base without rewriting it:

- `global/tools.json`: all five language servers, pinned private Node/.NET/Go/Rust support, and optional personal tools. New default profiles also include jscpd 5.4.1. Existing profiles are not silently extended. To add jscpd to an existing profile, add its verified catalog entry through Sandbox Tools, then adopt it with the normal approved rebuild.
- `{repos|projects}/<id>/devcontainer/tools.json`: project tool additions and catalog-version overrides.
- `{repos|projects}/<id>/devcontainer/project-environment.json`: project SDK/native-library installation recipes, companion files, explicit environment overrides, and ordered container lifecycle additions.

Provisioning sequence:
1. Resolve catalog versions from `tools.json` and build independently cached server/runtime artifact images.
2. Add sandbox infrastructure and compatible native libraries to the selected project base, then apply ordinary private project installations. These image builds do not receive LSP artifacts or their private runtimes.
3. Mount each catalog artifact's versioned directory read-only from its artifact image to `/opt/pi-tools/<id>/<version>` in the project container. Language servers and managed quality tools run there, with access to mapped project source, dependencies, and application toolchains.

   jscpd is a managed quality tool, not an additional required language server. Its Linux ARM64/x86-64 GNU/musl binaries are checksum-pinned, and its runtime version is probed.

A tool-only artifact change reuses the project image when native libraries and project recipes are unchanged. It still requires an approved session recreation and restarts language servers. Private LSP runtimes do not replace application executables or the application's global PATH. Server caches belong in writable home/temp/cache locations, not in the artifact mounts.

Startup probes the active Podman backend for immutable image subpath mounts, effective read-only enforcement, inspect provenance, and checkpoint exclusion. Effective read-only checks accept an explicit `ro` mount or Podman/Buildah's lowerdir-only overlay with no writable upper/work layer; the capability probe also attempts writes as root. Unsupported backends fail clearly; there is no copy or engine-storage bind fallback. Tool mounts are internal provisioning authority, not host access grants. `/sandbox status` reports them separately. Host binds cannot overlap `/opt/pi-tools`.

Older layered sessions with copied tools offer the existing approved rebuild on resume. Rebuilds preserve host binds but discard container-local changes; declining leaves the prior record/container unchanged. Resuming a session or recreating its container after a host mount change reattaches the saved artifact images, including for `commit --include-volumes=false` checkpoints. Missing saved images offer rebuild approval during startup, without requiring a ready session; denial or failed replacement preserves the saved record. Restoration remains an alternative, never silent version substitution. Pruned sessions retain saved catalog artifact identities while recreating their application image. Session pruning does not prune shared artifact images.

For an explicit local backend check, first pull a compatible Linux image with `sh`, `sleep`, and `awk`, then run:

```sh
bun run --cwd pi-permission-system test:mounted-tools docker.io/library/alpine:3.23
```

This synthetic probe verifies mount behavior, not real language-server compatibility. A user-run probe passed on Podman 6.0.2 with a macOS ARM64 client and Linux ARM64 server; the full native-library matrix remains unverified.

The extension's built-in server/runtime installation catalog targets Debian 12/13, Ubuntu 22.04/24.04, and Alpine 3.21/3.22/3.23 on ARM64/x86-64. Its download checksums and platform-specific installation recipes are pinned; the complete real-container matrix remains unverified in the implementation environment. Alpine Node is built from pinned source, so a cold build can be substantial. Bash, Python 3, ripgrep, Git, certificates, and required native libraries are added inside the derived image. Application runtimes are not replaced by the private LSP runtimes.

```json
{
  "permission": { "path": { "*.env": "deny" } },
  "sandbox": {
    "hostEnvironment": [],
    "startupTimeoutMs": 120000,
    "buildTimeoutMs": 1800000
  }
}
```

Legacy `auto` configuration requires migration through setup or an accepted General Settings edit; its classifier settings never authorize sandbox operations. Existing explicit denies remain policy restrictions. Operations within granted capabilities do not prompt, including installs, destructive project operations, credential-file access, remote mutations, and unresolved shell expansions. New host access and sandbox provisioning retain separate operator authorization. Delegated PR source disclosure is distinct from guest execution: recognized sensitive sources require fresh parent-owned disclosure approval, and sensitive local scans are refused without prompting. An approved bind alone does not authorize sending credentials to a provider.

## Setup and controls

```text
/sandbox
/sandbox status
/sandbox logs                  Show the latest diagnostic-log path
/sandbox setup global          # Complete fallback base
/sandbox setup global tools    # Shared personal tooling
/sandbox setup                 # Private project environment supplement
/sandbox setup tools           # Private project tool entries
/sandbox setup base            # Explicit private base replacement
/sandbox setup update
/sandbox off                   # Session-only escape hatch: run tools on the host
/sandbox on                    # Restore the devcontainer for this session
```

The first layered startup asks once to save the global server/runtime catalog when missing. It does not ask which languages to install. Existing base definitions remain bases; private supplements are separate documents. Global tool updates affect future builds, not running sessions. A resumed session with changed tooling, or a changed base definition, offers a rebuild that reapplies the saved binds as they are.

Settings → Sandbox provides manual editors for Global Container Base, Project Container Base, Project Host Commands, Global Sandbox Tools, Project Sandbox Tools, and Project Environment. Manual editors remain available even when the sandbox is unavailable and resolve private configuration paths from the current context's project identity without starting a container. `/sandbox setup global` and `/sandbox setup base` open the manual base editor directly, including during bootstrap. Manual edits do not restart the running sandbox; reload/rebuild adopts saved changes.

Both Sandbox Tools sections also offer **Add tool by name**. Enter a name with an optional version or requirements using the same input panel as Host Commands. The selected model prepares a pinned Linux installation recipe using the running sandbox's distribution and architecture; it receives only that platform information and your entered request, not project files, environment secrets, or conversation history. Review the recipe and destination in the existing installation approval preview. Approval builds and recreates the current sandbox, then saves to the selected private project/global `tools.json` and checks the runtime executable. Global recipes also affect future builds in other projects; other running sessions are unchanged. Cancelling generation or declining approval saves nothing. Failed builds preserve the previous profile and container. This action requires an idle session, a selected model, and a ready layered sandbox. Model-generated commands are not independently verified; review them before approval.

Base and project-environment configuration remain manual; ask the main agent for help preparing those documents. Required development tools can still use the approved `request_sandbox_tool` workflow. Existing `modelAssistedSetup` fields are ignored when loading settings and omitted on the next save; `/sandbox setup model on|off` is unsupported.

When startup fails in the TUI, a recovery menu offers:
- *Retry startup*
- *Rebuild (discard container state) and retry*
- *Open* the configuration the error points to: the failing tool profile entry, a recipe's missing prerequisite, Project Environment for lifecycle failures, or the devcontainer definition otherwise
- *Show the startup log path*
- *Turn sandbox off for this session*
- *Leave the sandbox unavailable*

When a pinned catalog version is no longer available, the error names the profile file, the entry, and the versions this extension provides. If the pin is newer than the catalog, it suggests reloading or updating the extension. The menu also offers *Switch `<tool>` `<old>` → `<new>`*, which rewrites only that entry through the revision-checked publication and retries. RPC and headless modes keep the hard failure.

In TUI mode, launch, reload/resume, mount recreation, and rebuilds show a full-screen animated progress console with elapsed time and a bounded tail of startup/build output. Usable terminals show a themed frame with current/previous stage, a labeled output pane, and live-follow/scrollback status; tiny terminals use a compact layout. The display reports real stage transitions rather than a guessed completion percentage. Use ↑/↓ or Page Up/Page Down to scroll, End to follow the latest output, and Esc to return to the thread while startup continues. The console steps aside for definition selection and sandbox authorization dialogs, then resumes unless dismissed. It closes automatically on success, failure, or shutdown. RPC and headless modes do not open a custom screen.

Each session keeps its newest 25 startup logs. Diagnostics record `podman inspect` results as a one-line summary (target, byte count, short digest) instead of the full JSON. Built-in guest file operations use one long-lived guest filesystem process per container instead of a `podman exec` per call. A slow request times out on its own (10 seconds for path probes, 30 seconds otherwise) without stopping the server; a lost server restarts on the next request. Per-request timings go to `sessions/<session-id-hash>/guest-timing.jsonl`, which keeps one previous file after 5 MB. The permission review log rotates to `<name>.1` at 500 MB.

Each top-level startup, resume, mount update, or rebuild saves a separate owner-only JSONL diagnostic log under `sessions/<session-id-hash>/startup-logs/` in the private sandbox storage root. `/sandbox logs` and `/sandbox status` show the latest path, including after a failed startup. Nested phases share the same log. Logs record timestamped stages and complete output chunks, including machine-readable CLI/Podman output that is hidden from the console; they are not clipped to terminal width or the display's bounded tail. Build output on screen retains steps, installation output, warnings, and failures while summarizing cache hits and omitting image-tag/hash lists. Logging also runs in RPC and headless modes. Log-storage failures warn without blocking sandbox operations.

Sandbox setup and JSON/multiline Settings fields open private drafts in fullscreen `$EDITOR` rather than rendering configuration blocks in the TUI. Save and quit to return to Pi. Settings fields save immediately without an Apply button, including General Settings and legacy migration. Standalone `/sandbox setup` retains its publication confirmation for edited definitions and companion files. `$VISUAL` and then `vi` are fallbacks when `$EDITOR` is unset. GUI editors require a wait flag.

Diagnostic logs and console output replace `containerEnv` and `remoteEnv` values and approved host environment-import values of four or more characters with `<redacted>` before writing. The container environment probe is logged as a variable count, not its values. Other secrets printed by lifecycle commands or present in image metadata are not detected. Sandboxed `read`, `ls`, `grep`, and `find` can read these logs, so treat undetected secrets in them as visible to the model. Inspect and redact before sharing; copy only the intended log into the checkout rather than mounting private sandbox authority storage. Logs are retained across attempts and require manual cleanup.

A new Pi session gets a new container. Containerfile bases still invoke the reference CLI's cached build path; this is not a fresh install when layers are cached. Shared server/runtime and infrastructure images are reused by build identity. Runtime executable availability checks share one guest process, while runtime version and effective read-only mount checks remain enforced.

Application tools such as Bun belong in the base or project supplement; private language-server installations generally should not be duplicated in the base. Review recipes before removing them because application builds may depend on those tools.

Selected devcontainer definitions load without an approval prompt, including in new sessions or after definition changes. Definition validation remains mandatory; loading a definition does not authorize additional host binds or host initialization. Standalone setup drafts still require approval before writing configuration. `initializeCommand` follows the spec's host semantics and needs fresh one-shot operator approval every time it executes. Headless, cancelled, denied, or stale initialization is blocked. Host environment imports must be explicitly allowlisted. Declared ports are forwarded automatically without approval and are bound to host loopback only.

## Sandbox-off escape hatch

Use this when the sandbox itself is what you need to fix: Podman failures, wedged startup, or work on this extension or `code-quality`. It is an explicit operator choice and never an automatic fallback.

- `/sandbox off` retires the current container, including an in-progress or hung startup, without waiting for the agent to go idle. `/sandbox on` waits for idle and starts the devcontainer fresh.
- Settings → Sandbox → General Settings offers the same toggle: **Turn sandbox off for this session** / **Turn sandbox back on**.
- `pi --no-sandbox` or `PI_SANDBOX=off pi` starts a session with the sandbox off and never touches Podman. Use this when the engine cannot start at all. The launch opt-out takes precedence over a recorded `/sandbox on`.

The choice is **session-scoped**. It is recorded as a `sandbox:mode` session entry, so `/reload` and resuming that session keep it. New sessions start sandboxed.

While off:

- Built-in `read`, `write`, `edit`, `ls`, `find`, `grep`, `bash`, and `!` user shell commands use pi's stock host implementations in the session cwd, with the host environment and full user privileges. Nothing is container-isolated.
- Explicit permission denies still apply: tool names, paths (raw, cwd-relative, absolute, and canonical host forms), whole Bash commands and units, and Bash path operands. Like the sandboxed gate, deny matching is best-effort, not secret exclusion.
- `request_host_mount`, `request_sandbox_tool`, `/sandbox setup|build|rebuild`, and the Rebuild action are refused until `/sandbox on`.
- The system prompt tells the agent it is running natively on the host.
- The Sidebar Sandbox tab shows `OFF · host passthrough`.
- `code-quality` suspends its gate for the session, closing any pending case as waived without a prompt. Delegated reviewer sandboxes and `pr_review` source capture remain unavailable.

## Missing development tools

When a required tool such as Bun is missing, the agent can use the model-only `request_sandbox_tool` tool instead of substituting another runtime or trying host execution. The request includes the tool name, pinned version, Linux-compatible install command as an argv array, expected executable, build prerequisites, reason, and optional installation-only environment values.

In layered environments the request saves an approved recipe into the private project's `tools.json`, not the repository definition or global fallback. The preview identifies the write scope and rebuild consequences. The image is built before the private project's `tools.json` is updated; failed builds retain the prior file and container. Approved binds and runtime settings are preserved, but rebuilds discard container-local changes. Legacy non-layered callers retain active-definition installation behavior. The tool probes the executable as the runtime user before reporting success; install on the runtime PATH or use an absolute executable path.

Before asking for approval, an unmanaged recipe's `prerequisites` are checked in the running sandbox with one `command -v` probe. A prerequisite that another profile tool provides (matched by tool id or executable name) is accepted and recorded as a dependency, so it is built first. Any other missing prerequisite refuses the request without saving anything, and tells the agent to request that prerequisite first.

The installation progress screen remains open through runtime executable verification, and tool updates distinguish rebuild completion from probe completion. The probe times out after ten seconds; guest-process termination is limited to five additional seconds before closing the host Podman exec. If Podman is unresponsive, remote termination cannot be confirmed. A failed probe reports an error without undoing the saved recipe or successful rebuild.

Saved private installations apply to future sessions for this project and its worktrees. Use **Global Sandbox Tools → Add tool by name** or edit the global tool profile to share a personal recipe across projects. Matching profiles and artifact cache keys avoid repeated installation. Installation runs as root during the container image build, never as a host install, and grants no mounts or sandbox exceptions. The request is explicit agent intent, not automatic command-not-found interception.

## Project-specific host command routing

Manage rules in **Settings → Sandbox → Project Host Commands**, or create/edit this project's private file directly in your editor:

```text
~/.pi/agent/extensions/pi-permission-system/{repos|projects}/<id>/host-commands.json
```

Saving the file or accepting an addition/removal in Settings is the authorization: there is no separate approval command, Done/Apply button, extra approval dialog, generated proposal, or image rebuild. Settings creates the profile on the first accepted edit if needed; keep manually edited profiles outside the agent's mounted checkout. Rules are read on each Bash call and rechecked before every native invocation. Missing files mean no host commands; invalid profiles block shell execution rather than silently weakening routing. Git worktrees share the profile but execute against their own project root and session's approved mappings. Non-Git descendants find the closest private project profile.

```json
{
  "hostCommands": [
    { "script": "./build.sh" },
    { "executable": "dotnet" }
  ]
}
```

`script` selects an exact project-root-relative script, including its future edits; it must be executable and resolve inside the project. It does not authorize other scripts with the same basename. `executable` selects a command name resolved through the host Pi process's PATH, with any arguments. An optional absolute `path` selects its host binary explicitly, for example `{ "executable": "dotnet", "path": "/usr/local/share/dotnet/dotnet" }`. The executable name and that explicit path both route natively. No project rules are created automatically.

Both agent Bash and user `!` shell commands use the same routing. Tree-sitter identifies literal invocation names and rewrites only those names to a per-call bridge. Guest Bash still controls `&&`, `||`, `;`, loops, substitutions, pipes, redirects, and argument expansion:

```sh
git diff --check && dotnet build App.sln | grep warning
CONFIG=Debug ./build.sh --ios > build.log
```

Host stdout/stderr and stdin stream through the bridge; nonzero native exit codes preserve Bash short-circuit behavior. Each native invocation emits `[HOST] <command> · <host-cwd>` on stderr (and therefore participates in ordinary stderr redirects). The bridge uses a guest-only Unix socket and Podman stdio, not a host network listener or host socket mount. Cancellation, timeout, container replacement, and session shutdown terminate owned native process groups. Deliberately detached daemons are outside that process-group guarantee. No TTY is allocated.

The working directory must map through an approved bind to a directory inside the current host project. Arguments expand in the guest and are passed as argv without host shell reparsing; arbitrary argument paths are not translated. Prefer project-relative files shared by the workspace bind. Guest `$HOME`, guest-only temporary files, and guest process-substitution `/dev/fd` paths do not name equivalent host resources. Host execution inherits the Pi host environment/toolchain; only explicit command-prefix assignments are forwarded from the guest. PATH, HOME, shell initialization/options, and Node/Python/dynamic-loader lookup overrides are rejected for native invocations.

Host routing rewrites only statically matched command names. Dynamic or escaped executable names, function definitions and calls to functions declared in the same shell input, and command names inside opaque strings or wrapper arguments (`eval`, `source`, `bash -c`, `env`, `sudo`, `command`, and related forms) are left to guest Bash rather than rejected. Separately visible literal commands in the same input can still route natively. A wrapper itself routes natively if explicitly configured as a host executable. Inputs the parser cannot fully parse are passed unchanged to guest Bash without partial host routing; Bash reports any syntax errors.

Code inside external scripts is not rewritten: a guest script stays guest, while an authorized native script and its children stay host. Other literal commands run in the container; failure never retries them on the host. Existing explicit-deny checks remain effective, but are not comprehensive controls over arbitrary host arguments or script behavior. Sensitive-file and external-effect operations do not receive additional approval prompts.

**These are trusted host exceptions, not isolation.** A rule authorizes everything its executable can do with any arguments, including modified project scripts, MSBuild targets, package restores, tests, Xcode phases, host files, network access, and host credentials. File tools and LSPs remain container-backed. Native script/command mutations are not covered by the explicit edit/write quality gate. Use a dedicated account or machine if those host privileges are unacceptable.

## Additional host access and lifecycle

The model-only `request_host_mount` tool accepts a host `path`, optional guest `destination`, `access` (`ro`/`rw`), and `reason`. The broker displays canonical source, destination, mode, and restart impact. Mount grants persist privately for the Pi session, including resume, but new sessions/forks do not inherit them. Configuration identity never grants access to another worktree or shared Git metadata.

Failed guest read-access checks report the resolved guest path, guest existence/readability, and whether the checked host path exists as a file, directory, or other entry. Approved mounts translate guest paths to their host sources; unmounted paths are checked at the same absolute host path. Host metadata failures report an unknown status rather than absence. These diagnostics inspect metadata only, never read host contents or grant access. The error instructs the model to call `request_host_mount` for an existing unmounted host file or directory, request read-only access, and retry after human approval; already-mounted paths point to permissions or missing-path troubleshooting instead.

`read`, `ls`, `grep`, and `find` run on the host, with no mount, for absolute paths under four code-owned read-only roots: Pi's own package (README, docs, examples, resolved from the loaded `@earendil-works/pi-coding-agent`), session transcripts under `<agent dir>/sessions`, other extensions' `<agent dir>/extensions/<name>/config.json` files, and sandbox startup logs under `sessions/<session-id-hash>/startup-logs/` in the private sandbox storage root. The rest of the pi-permission-system private storage and `auth.json` are never included. `edit`, `write`, and `bash` never route to the host. Explicit tool and path denies still apply to routed reads.

Reload and resume validate each approved source's canonical path, kind, and device/inode identity. If a regular file or directory at the same canonical path was replaced (for example, a configuration file saved atomically), startup asks for renewed approval. Approval retains its destination and access mode, checkpoints container-local state, and recreates the container with the replacement bind. Denial leaves stored authority unchanged and the sandbox unavailable. Missing sources, changed kinds, and redirected symlinks remain blocked.

## Project volumes

Devcontainer `mounts` entries with `type=volume` (string or object form) become Podman named volumes owned by the sandbox, not host access grants. The sandbox ignores the declared `source`, including `${devcontainerId}`. It names each volume `pi-vol-<project>-<hash>`, derived from the checkout root and the target. Every session started from the same checkout therefore reuses the same volume, while other worktrees get their own. Volumes are attached without an approval prompt because they never expose host paths. Data written there persists into later sessions of the same checkout. The sandbox creates missing volumes with the labels `pi.sandbox.volume=1` and `pi.sandbox.project-root=<checkout>`. It refuses a same-named volume labeled for another checkout.

Volumes may sit inside a host bind (for example, `node_modules` inside the workspace). A host bind may not be nested inside a volume, and volumes may not overlap each other or protected guest roots. Guest paths under a volume have no host mapping: path policy, host-command routing, and source authorization never translate them to the shadowed host directory. Container inspection must show exactly the approved volume names, destinations, and modes. Checkpoints exclude volumes. Mount changes, rebuilds, and resume reattach the saved volumes. Session pruning never removes volumes; remove them manually with `podman volume ls --filter label=pi.sandbox.volume=1` and `podman volume rm <name>`. Other mount types (`tmpfs`, binds without a source) are still rejected. Containers run with `no-new-privileges`, so lifecycle hooks cannot use `sudo`. A newly created volume inherits the ownership of its image directory.

Mount changes stop active container processes, checkpoint container-local changes without including bind volumes, and recreate the devcontainer with the approved topology. Session container stops use zero graceful-stop delay and a separate 15-second command timeout during rebuild, resume recreation, rollback cleanup, and shutdown. Stop failures identify the container and retain Podman stderr and termination details.

During a mount update, progress reports stopping and checkpointing separately. Both commands follow operation cancellation. Normal resume reuses the stopped container and its start/attach lifecycle; recreation runs new-container creation hooks, which should be idempotent. Private checkpoint images can contain copied sensitive data and must never be published.

LSP installation belongs to sandbox provisioning. `/quality lsp setup` only configures exceptional analysis settings against already provisioned servers; it never installs tools or rebuilds the container. Trusted projects with quality enabled infer ordinary routes automatically. Project SDKs/dependencies still belong in the selected base or private project supplement.

Containers have readable names such as `pi-my-project-<session-suffix>-g2`, with project-root, startup-directory, session, and generation labels for Podman Desktop. Successful mount recreation and rebuilds remove the superseded container after replacement forwarders start and the updated session record is saved. Failed replacements retain the previous container for rollback; cleanup failures do not roll back a successful replacement.

### Container lifetime

- **`/reload`** leaves the running container in place. The reloaded extension reattaches it after re-inspecting its session label and isolation policy, without running `devcontainer up` or lifecycle hooks. Processes, `/tmp`, and other container-local state survive. When the container is gone, the definition changed, or an approved source was replaced, startup falls back to the normal resume path.
- **Quit, new session, resume of another session, and fork** stop and remove the container, and remove this session's `localhost/pi-sandbox-*` image and mount-change checkpoint images. Outside `/reload` the container is disposable. Resuming the session later recreates it from the validated definition with the saved grants and volumes, and runs creation hooks. Shared `pi-project`/`pi-tool` layer and artifact images stay cached, so recreation reuses them.
- **Startup cleanup** runs during "Pruning inactive sandbox sessions…":
  - removes every `pi.sandbox.session`-labelled container whose session has no live owner, including orphans from startups that failed before saving a record;
  - removes `pi-sandbox-*` images that belong to no live session;
  - deletes failed-start session directories that have no saved record after seven days.
  Cleanup is best-effort: failures are reported in the startup log and do not block startup.
- A failed `devcontainer up` removes any container it created for that generation before reporting the error.
- **Owner locks** record the owning Pi process ID. A lock left by a process that is no longer running is taken over automatically and noted in the startup log; a lock held by a running process still blocks the session.

Removal deletes container-local development state, not host bind files, conversation history, saved mount grants, definitions, volumes, or shared images. Private checkpoint images can contain copied sensitive data and must never be published.

## Integration

Built-in read/edit/write/find/grep/ls use the guest backend. Agent Bash and user shell commands keep their shell in the guest, with native invocations only for configured project host-command rules. PR capture and exact-result retrieval remain bounded host infrastructure with approved mapped-source checks. Quality reviews guest-accessible files, including approved external mounts, without repository-membership filtering. Quality models/private metadata remain host-side; LSP setup and analysis run inside Podman.

Each logical PR worker (including planning, verification, and setup workers) owns a dedicated container
created lazily from the session's prepared image. No rebuild or new host access is granted. Approved
binds are mounted read-only; the root filesystem is read-only, network access is disabled, capabilities
are dropped, and resource limits bound the path-probe workload. Workers do not inherit container-local
changes or processes from the main sandbox.

A persistent, path-only Python transport serves source-authorization probes inside each worker container.
It does not expose file mutation, shell execution, or model credentials. Worker source checks remain
individual and live; they no longer launch one Podman exec per source. Host capture/output operations
retain bounded 32-source batches through the main sandbox service. Models and immutable PR snapshot
storage remain host infrastructure; private PR runtime storage is not mounted into worker containers.

Completion and cancellation await worker-container removal. Disposable reviewer removal uses zero
graceful-stop delay, tolerates an already-removed container, and has a separate 15-second command timeout.
Removal errors retain Podman stderr and termination metadata.

Transport failure retires that worker's container before an explicit retry can recreate it;
sibling workers retain their containers. Sandbox
rebuild, mount changes, tree navigation, reload, and shutdown retire affected workers. Probe results are
not cached approvals. Mount identities, symlink mappings, live path policy, and revision checks remain
authoritative. Container-runnable tests check reviewer launch isolation arguments, persistent Python
path transport, source authorization, failure recovery, and retirement. They do not certify real
engine enforcement or platform image compatibility.

The following installed npm package tools are authorized to execute on the host without additional sandbox approval prompts or a ready container:

| Package | Authorized tools | Recognized entry points |
| --- | --- | --- |
| `@juicesharp/rpiv-ask-user-question` | `ask_user_question` | `index.ts` |
| `pi-web-access` | `web_search`, `source_check`, `fetch_content`, `get_search_content` | `index.ts`, `dist/index.js` |
| `@plannotator/pi-extension` | `plannotator`, `plannotator_submit_plan`, `plannotator_mark_done` | Package root (`./`), `index.ts` |

These exceptions require matching package provenance, entry point, and tool name; versioned and unversioned npm specifications are accepted. They do not activate tools disabled by their package or current UI/phase settings. Explicit tool denies and cancellation still apply, and unreadable/invalid permission settings fail closed. Sandbox migration is not required for these host tools. Other extensions with the same names, unlisted package capabilities, and unknown host/MCP tools remain blocked.

Authorization retains each package's existing behavior rather than routing it through Podman. The questionnaire's user-invoked external editor edits a temporary host answer. Web tools can use host filesystem access, subprocesses, configured credentials, browser cookies, uploads, and background fetches when enabled by the package. Plannotator can read/write host plans, launch live viewers, and perform event-driven checklist/todo updates. Those internal operations are not mediated by guest mount/path/command guards or the explicit edit/write quality gate. This is trusted host execution, not container isolation; it grants no automatic host fallback to built-in file or shell tools.

`permissions:*` retains human prompt/decision correlation. `sandbox:state:v1` and `sandbox:discover:v1` expose bounded presentation data to Sidebar; the separate trusted service is not model-callable.

## Verification

```sh
bun run --cwd pi-permission-system check
```

Tests run inside the supported Podman devcontainer without requiring a nested engine or private host tool installations. Native-shell and Python-process regressions exercise real subprocess transport; synthetic engine ports exercise isolation, provisioning, and lifecycle contracts. These tests do not establish live-engine or cross-platform image compatibility. See `FORK.md` for historical provenance; the former classifier implementation is retained only as source/test migration context, not loaded by the package entry point.
