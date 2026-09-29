# Quality extension: file-scoped LSP diagnostics

## Context

Add language-server quality feedback after successful `edit` / `write` operations. The user wants project-specific server configuration, guided setup, the configured LSP and its running state beside the analyzer model in the existing quality row, and one shared warm LSP for Pi instances using the same checkout and server configuration. Errors, warnings, informational diagnostics, and hints all enter the correction flow. The shared LSP closes after its last Pi client disconnects.

Scope is LSP diagnostics for edited files, not build commands, test runners, repository-wide review, or ReSharper CLI integration. Clean file diagnostics are not a successful-build guarantee.

Implementation approved and executed. Unrelated working-tree changes were preserved; no commits or project LSP activation were performed.

## Findings that shape the design

- Pi awaits `tool_result` transformations before returning feedback; sibling tool calls can execute concurrently. The existing quality controller instead finalizes cases at turn/settlement boundaries. Use both boundaries without counting one edit twice.
- Existing `QualityCase` / `CaseStore` infrastructure already handles correction scope, five-round escalation, snapshot approval, and branch recovery. Its readability verdict requires an exact patch, so add separate LSP evidence rather than weaken that verdict schema.
- PR profiles provide the right private-storage model: canonical Git common-directory identity, draft/approve activation, locked compare-and-swap publication. Reuse this design without importing PR internals across independently packaged extensions.
- `code-quality:status` already supports session-scoped header replay, and Atelier renders its `modelId`. Extend this contract with server state while retaining existing counters and per-tool badges.
- LSP freshness is not uniform. TypeScript's server can publish an empty list to clear stale errors before analysis completes; some servers dynamically register several independent diagnostic providers. Silence, an empty clearing notification, or a successful initialize handshake cannot establish a clean check.
- Pi awaits normal shutdown/reload/session-replacement cleanup, but emergency exits may bypass hooks. A shared broker must track live client connections, release disconnected clients, and shut down its LSP when the last client leaves.
- LSP assumes one client owns a document's version history. Several Pi processes cannot safely multiplex independent `didOpen`/`didChange` streams directly onto one server. A broker must be the sole LSP client, own document versions, and validate disk snapshots on behalf of Pi clients.
- No reusable shared-process lease or LSP broker exists in this repository. PR private storage and locking remain useful patterns; the shared lifecycle/IPC service is new, narrowly scoped infrastructure.
- The permission extension's delegated service is intentionally PR-only/read-only. Do not repurpose it for LSP execution. The approved setup is explicit authorization for trusted local subprocesses; it is not a sandbox or per-file permission enforcement.

## Approach

Add LSP checking to `code-quality`, **alongside the unchanged readability policy**, with the existing case and correction/arbitration flow in each Pi session. Pi instances share an LSP through a small local broker; they never share quality cases, notes, correction counters, or operator approvals. Support macOS and Linux/WSL in TUI mode. No native Windows, RPC/print enforcement, auto-fixes, navigation tools, or full-build claims in v1.

### 1. Private project configuration and guided setup

Commands:

- `/quality lsp setup`: detect candidate languages/roots, choose presets or a custom server, offer approved installation, validate, and approve the configuration in one guided flow.
- `/quality lsp setup edit|approve`: reopen the private draft or activate an externally edited draft using the same validation/approval path.
- `/quality lsp status`: list all roots, configured commands/versions, lifecycle states, diagnostic coverage, timings, and actionable failures.
- `/quality lsp doctor [server-id]`: validate executable, initialization, project loading, and a representative file's diagnostics. Existing findings at any severity mean the server works but the file is not clean. Reuse the shared broker when its configuration matches.
- `/quality lsp restart [server-id]` and `/quality lsp on|off`: explicit recovery/control. Disabling required checks in a pending case requires the existing waiver confirmation.

Keep `/quality status|retry|resolve|on|off` and `/quality-model`. Plain status never waits for the agent to become idle; serialize configuration changes and restarts against active checks. Reconfiguration during a paused case preserves its ID, scope, notes, and round budget, but invalidates old diagnostics.

Store under `getAgentDir()/extensions/code-quality/`:

```text
repos/<canonical-git-common-dir-hash>/lsp-profile.json
repos/<id>/lsp-profile-draft.json
projects/<canonical-folder-hash>/lsp-profile.json
tools/<server>/<version>/<platform-arch>/...
brokers/<server-key>/registry.json
brokers/<server-key>/<generation>/...
connections/<instance-id>/...
```

Git worktrees share profiles, never runtime state. Resolve workspace roots relative to each checkout; starting Pi in a Git subdirectory uses the same repository profile. For non-Git folders, setup confirms a project root and descendants use the nearest configured canonical ancestor. Distinct clones remain distinct. Nested workspaces route by the deepest configured root; no implicit execution of configuration found in source files.

Profiles contain a schema version, approved revision, enabled flag, and named routes: relative root, language IDs/extensions, optional solution/project selection, preset/version or executable plus argument array, environment overrides, initialization options, workspace settings, and timeout overrides. Require unique server IDs and explicit selection when roots/solutions are ambiguous. Multiple routes may serve the same file at the selected root; all configured routes must finish before that file passes. A custom stdio server uses the same client; no arbitrary executable plugin scripts in the profile.

Reuse PR-style private permissions, symlink/path checks, editable drafts, exclusive publication locks, and expected-revision checks. Two setup sessions cannot overwrite each other's approved configuration. Changes to executable configuration require reapproval. A running session detects a changed approved profile at an action boundary and reloads safely; ordinary source edits never require setup again.

Setup performs deterministic filename/manifest discovery, not a model-generated installation script. Show exact commands, versions, destinations, roots, and local-process implications before execution. Obtain execution consent **before the validation probe**, then a final configuration activation decision; cancelling leaves the prior approved profile intact. Reuse an existing suitable installation if selected; otherwise install pinned servers into private Pi tool directories. Use per-install locks and staged publication so concurrent Pi instances never see a partial install. Do not modify project dependencies, shell PATH, system packages, or SDK installations. Missing prerequisite SDKs produce instructions. No silent server downloads/upgrades during checks or startup; language-server-managed dependency restores must be disclosed separately.

Approving the profile authorizes future local analysis for that project. Require project trust before startup. Servers can read dependencies, run project analyzers/build tooling, inherit approved environment, and write caches; this is explicitly disclosed. The client rejects server-requested workspace edits and interactive commands. No per-edit execution prompt, and no false claim that the permission extension mediates the server's internal filesystem access.

### 2. Standard client with tested server presets

Use `vscode-languageserver-protocol/node::createProtocolConnection` and protocol types in the broker. Declare dependencies explicitly; do not use the VS Code extension-host client or import another Pi extension's singleton manager. Use a maintained watcher/glob implementation for approved workspace file-change registrations, declared as runtime dependencies where imported. The standalone `.mjs` broker bootstrap loads its TypeScript modules through an explicitly declared `jiti` dependency; do not assume Pi's parent-process loader or undeclared packages are available.

Initial preset targets:

| Language | Server | Setup/compatibility requirements |
| --- | --- | --- |
| C# | Official `roslyn-language-server` | Broker-owned stdio mode, automatic or selected project loading; disclose prerelease versions; support compiler, analyzer, style, and suggestion diagnostic providers. Disable Roslyn's own daemon mode; our broker provides sharing. |
| TypeScript/JavaScript | `typescript-language-server` with the intended TypeScript version | Prefer project TypeScript; report bundled fallback explicitly. Freshness may require its documented, narrowly allowlisted diagnostic-only `typescript.tsserverRequest` bridge rather than unversioned push results. |
| Python | Pyright | Respect project/interpreter configuration; use pull diagnostics where advertised. |
| Rust | rust-analyzer | Track native and check-on-save diagnostics separately; await the relevant check completion. Disclose cargo/build-script execution and possible latency. |
| Go | gopls | Respect module/workspace configuration; verify fresh per-document diagnostics and project readiness. |

**First implementation milestone:** pin and probe all five presets using isolated tiny fixtures. Verify syntax/semantic errors and non-error diagnostics emitted by each server, repair to clean, clean-to-clean changes, and shutdown. Fake-server tests must exercise all four severity levels and omitted severity. Establish an explicit fresh-result/completion rule for each pinned server; do not advertise a preset as supported merely because it initializes. If a required preset cannot meet this contract, stop and report the limitation rather than weaken the gate or silently omit that language.

Client requirements:

- Initialize with root URI/workspace folders and the broker's process identity, not the first Pi client's PID; handle configuration requests, dynamic register/unregister, progress, and diagnostic refresh.
- Track diagnostic providers by registration ID, identifier, and document selector. Pull all applicable providers; merge full/unchanged reports without mixing provider result IDs or server generations.
- Synchronize `didOpen`, negotiated full/incremental `didChange`, `didSave`, and `didClose`. Use correct URI escaping and negotiated position encoding; preserve file versions and hashes.
- Register waiters before notifications. Prefer pull responses tied to a serialized document generation. For push-only servers require tested freshness/completion semantics; an initial clearing notification or silence timeout is not a pass.
- Preset-specific protocol handling remains inside small adapters. Only named diagnostic requests are allowed; no agent-facing raw LSP command interface. Custom servers without a reliable diagnostic contract are explicitly unsupported for gating.
- Handle watched-file registrations and external changes within approved roots, including files created by another Pi instance. Resynchronize open-file overlays before checking; watcher events do not expand the set of files being reviewed.
- Use cancellable deadlines. Initial configurable defaults: 60 seconds for startup/project readiness, 10 seconds for document diagnostics, and 3 seconds for graceful shutdown before termination escalation. Measure rather than promise subsecond latency.

### 3. Shared warm LSP and multi-instance lifecycle

#### Sharing identity and startup

Keep **one broker-owned LSP per equivalent checkout/workspace/server configuration**, not one per Pi process. Compute its key from the canonical physical workspace path, server executable/version, relevant launch environment, normalized server settings, and broker protocol version. Use a defined environment selection that excludes Pi session/model variables; hash relevant values without publishing secrets. Display names and Pi session IDs do not split otherwise equivalent servers. Different worktrees/clones and materially different server configurations remain separate; show the reason in status when sharing is not possible.

At session start, each configured Pi instance asynchronously attaches to the existing broker or starts it once under a per-key startup lock. The winner initializes the server; other clients attach to that same warmup operation. Use private Unix-domain sockets and ownership/token checks, with a short socket-path strategy for macOS limits. Registry publication includes an unguessable generation and authenticated handshake; never trust a PID or stale socket alone. Resolve abandoned startup/shutdown state under the same lock, and do not start a duplicate while the prior server's retirement is uncertain.

The broker runs independently of whichever Pi instance started it and becomes the **sole LSP client**. It owns the server's stdin/stdout, request IDs, document versions, providers, workspace watchers, cached diagnostic results, and process group. Keep server-native daemon mode disabled: sharing is handled uniformly by our broker, without an extra server lifetime we cannot control.

#### Client leases and shutdown

Each Pi instance holds a live authenticated connection/lease. Quit, reload, session replacement, and local disabling release that lease and cancel only that client's pending requests. Socket EOF after a crash releases the lease too. Do not use a persisted numeric reference count or rely on PID reuse-prone liveness alone.

- While any clients remain, the broker and LSP remain warm. Closing the creator Pi has no special effect.
- When the last client disconnects, retire the broker generation and perform LSP shutdown/exit followed by bounded TERM/KILL escalation for its owned server group; remove only that generation's runtime/socket files.
- Serialize last-detach versus new-attach. A new client either joins the still-active generation or waits for retirement before starting the successor; never revive a half-closed connection or launch two equivalent servers.
- Normal Pi shutdown awaits release acknowledgement, and the last client also awaits bounded server teardown. Abrupt last-client death is cleaned up by the surviving broker.
- Tree navigation invalidates that client's pending results and case state, not other clients' work. A cancelled turn withdraws its own waiter; shared work needed by another client remains active.

Use a broker-owned process guard/control pipe for abnormal broker exit so its LSP group is also retired when possible. Keep the guard bound to broker lifetime, not the launching Pi. Normal teardown is idempotent; never kill by executable name or inspect unrelated process trees. Simultaneous uncatchable termination of broker and guard, or a custom server deliberately escaping its group, remains outside the guarantee.

#### Shared diagnostics and recovery

The broker accepts only narrow operations: attach, check approved file snapshots, status, cancel a client request, detach, and explicit coordinated restart. Requests identify the client, requested files/hashes, and configuration generation; the broker validates paths and reads the actual current disk content. Pi clients do not send competing unsaved overlays. A superseded hash returns stale, never overwrites the broker with an older buffer.

Serialize document synchronization and generation capture centrally. Share in-flight work only for identical file/workspace/configuration generations, with separate cancellation ownership. Route diagnostics only to requesting clients and scope, while broadcasting sanitized process state and workspace invalidation. Quality-case decisions and approval remain local to each Pi session. If another instance edits an outstanding case file, the existing snapshot-freshness flow invalidates it; this is not a cross-Pi write lock.

A server/broker crash marks checks unavailable for all affected clients. Coordinate restart under the server-key lock so simultaneous retry choices do not create a restart storm. `/quality lsp restart` warns that it affects attached clients, retires pending requests without counting quality failures, broadcasts the new generation, and resynchronizes. Local `/quality off` only detaches that instance; changing a persisted LSP profile is a project-wide configuration change observed by other clients at action boundaries. Removing required checks still requires each affected pending case's explicit waiver.

Use runtime/log/cache directories per broker generation where supported. Background startup failures show status and require recovery when a matching file needs checking, without interrupting unrelated work. The UI distinguishes `connecting`, `starting`, `loading`, `ready`, `checking`, `stopping`, `stopped`, `failed`, `disabled`, and `unconfigured`.

### 4. Edit/write feedback and the shared quality case

After each successful in-scope mutation, capture its post-write snapshot and request matching broker checks. Return bounded file diagnostics with the original tool result, preserving its content, details, usage, and successful-write status. Failed/denied operations do not become successful checks. Report superseded results explicitly if another write overtook the captured version.

At the existing batch boundary, reconcile all changed files and confirm results against the final batch revision. Parallel sibling edits may make early diagnostics obsolete; recheck affected case files after final synchronization rather than reject based on an intermediate state. Track an observed workspace-change generation as well as file hashes; reject results invalidated by dependency/configuration changes, including while the model reviewer is running. This is change detection, not an atomic filesystem lock. Never hold the file-mutation queue while waiting for LSP or operator input.

**All diagnostics reported for the edited files block:** Error, Warning, Information, and Hint, including pre-existing findings. A diagnostic with omitted severity also blocks rather than disappearing. Preserve its original severity and diagnostic tags for display; do not relabel hints as compiler errors. Ignore non-diagnostic log/progress messages as findings.

Do not restrict findings to changed lines or invent checks in other files. Respect the server/project's configured rules and explicit suppressions; do not enable every disabled rule or let the agent lower severity to bypass the gate. No client-side minimum-severity filter. Request analyzer/style/suggestion providers as well as compiler providers where supported.

Preserve server, provider, code, message, range, and revision provenance. Unconfigured routes, exclusions, unsupported content, and timeouts remain distinct from clean checks; maintain current generated/binary/sensitive-content handling without treating a model disclosure waiver as an automatic LSP pass.

Generalize the case record to distinguish LSP assessment from readability verdict. Keep `proposal.ts`'s model schema/policy intact. Model review receives only readability context; it cannot approve or dismiss LSP diagnostics of any severity.

Pass sequence:

1. Fresh LSP checks for all configured in-scope files.
2. If any diagnostics remain, record one rejection and return them with their original severities through existing correction feedback.
3. If clean, run existing readability review. Approve only when every required check is satisfied or explicitly accepted by the operator.

Use **one case and five response-and-check rounds after the initial rejection**, shared across both stages. A pass counts once, not per file/server/tool call. Read-only investigation and infrastructure retries consume no round. Preserve correction scope restrictions, user-approved helper paths, premature-completion handling, and another-five-rounds arbitration. A disagreement about LSP records the argument and reruns fresh diagnostics; neither agent nor model can waive it.

Arbitration shows current code, source-labeled findings, and optional case notes. Offer accept current and another five rounds even without a patch. Offer accept proposed only when an exact validated readability proposal exists. Accept current explicitly records which checks failed or were not run; it is user approval, not a clean LSP/model verdict.

After applying an operator-approved proposal exactly, require fresh LSP checks before closure. If diagnostics of any severity remain, keep the same case; at the exhausted limit, return to operator choices. Subsequent code corrections invalidate content-specific readability approval and require normal checks again.

Infrastructure failures use the existing paused-case flow with restart/retry, reconfigure, and explicit waiver choices. Separate source-scoped waivers from whole-case acceptance. Diagnostics/results from old file, workspace, profile, session, or server generations cannot approve anything. Revalidate unresolved cases on resume; no persisted 'server running' state is trusted.

Persist a versioned case schema with a reader for existing v1 cases and review counters. Pure revert/no-change closure must not label LSP clean or erase a pending diagnostic; skip redundant checks only when the recorded result still matches the current file/workspace/configuration generation. Store full bounded diagnostics in private case data; show a compact preview and complete-result locator when needed. If a safety budget prevents complete capture, pause rather than silently drop findings. Sanitize display text and treat diagnostic messages as untrusted data.

### 5. Quality-row presentation

Extend the existing replayable header with optional structured LSP server entries; older events remain readable. Do not encode server state into `modelId` or the readability phase.

```text
󰅴 quality · provider/model · roslyn ● ready · ts ⟳ checking

Narrow terminal:
󰅴 quality · provider/model
            roslyn ● ready · ts ⟳ checking
```

Show every configured route, including failed/stopped routes; disambiguate duplicate server names with short workspace labels. Add a compact shared-client indicator, such as `roslyn ● ready ×2`, when multiple Pi instances share it; detailed status includes broker generation and attached-client count. Distinguish this client's `checking/queued` state from a server busy for another client. Wrap whole entries using existing width-aware TUI helpers. `ready` means the process can serve requests, not that the code is clean. Use existing tool quality badges for the aggregate case result and add severity-labeled diagnostic details to expanded feedback.

Keep one check/rejection count per finalized quality pass. Internal LSP requests, warmup, retries, and file fan-out do not inflate those counters. Publish no source code, raw arguments, environment values, or diagnostics over presentation events. Extend attention events/desktop notifications for setup, installation approval, and LSP recovery; routine checking stays silent. Provide `/quality lsp status` and ordinary status text when Atelier is absent.

## Files to modify

| Area | Paths |
| --- | --- |
| Shared gate and lifecycle | `code-quality/index.ts`, `controller.ts`, `case.ts`, `state.ts`, `feedback.ts`, `ui.ts`; change `config.ts` only where global on/off integrates with server lifecycle. Keep readability policy/verdict schema unchanged. |
| Project profile and setup | New `code-quality/lsp-profile.ts`, `lsp-setup.ts`, `lsp-presets.ts`, `lsp-install.ts`. |
| LSP runtime | New `code-quality/lsp-client.ts`, `lsp-manager.ts`, `lsp-diagnostics.ts`, `lsp-watch.ts`, `lsp-broker.ts`, `lsp-broker-protocol.ts`, `lsp-broker-registry.ts`, and Node-loadable `lsp-broker-host.mjs` / `lsp-process-guard.mjs` entry points. Keep preset-specific diagnostic operations in `lsp-presets.ts` or a cohesive adapter module if needed. |
| Status and UI | `code-quality/activity.ts`; `pi-atelier/src/quality-activity.ts`, `sidebar.ts`, `pi-atelier/extensions/index.ts`; `desktop-notifications/core.ts` for new attention labels. |
| Package/docs | `code-quality/package.json`, `verify-pack.mjs`, `README.md`, `CHANGELOG.md`, root `bun.lock`; `pi-atelier/README.md`. Explicitly package broker/guard entry points and their runtime dependencies, not just existing `*.ts` files; verify launch outside Pi's in-process loader. |
| Tests | New matching `code-quality/lsp-*.test.ts`, fake-LSP/process fixtures, opt-in preset probe fixtures; extend `controller.test.ts`, `core.test.ts`, `activity.test.ts`, `ui.test.ts`, capture/state coverage, Atelier quality/sidebar/extension tests, desktop notification tests, and `tests/code-quality-integration.test.ts`, `quality-notifications-integration.test.ts`, `package-integration.test.ts`. |

No production PR-review or permission-system changes are planned. Preserve their current worktree edits.

## Reuse

- `createQualityActivityPublisher` in `code-quality/activity.ts`: status replay, session identity, bounded per-call history, and attention notifications.
- `canonicalPath` in `code-quality/capture.ts`: workspace/file identity, subject to review of LSP URI needs.
- `loadConfig` / `saveConfig` patterns in `code-quality/config.ts`: strict parsing and private atomic persistence.
- `QualityCase`, `recordVerdict`, `resolveCase`, and `CaseStore` in `code-quality/case.ts` / `state.ts`: generalize evidence while preserving the shared correction/arbitration flow and existing stored-case compatibility.
- Generation/lifetime guards in `code-quality/controller.ts`: reject stale asynchronous results; server failures remain infrastructure failures, not consumed correction rounds.
- `pr-review/storage.ts::publish/readStored` and `pr-review/setup.ts::approveSetup`: adapt their private draft/activation and revision-conflict design into the quality profile store. Avoid copying PR report exceptions, model discovery, or Git snapshot machinery.
- `pr-review/git.ts::resolveRepo`: use the same canonical Git common-directory identity algorithm; add a non-Git canonical-root case. No cross-package source import or new shared runtime package.
- `pr-review/plannotator.ts`: reference for awaited TERM/KILL shutdown and private runtime directories. New broker/guard code provides shared ownership and abnormal-exit handling; do not reinterpret that single-owner helper as a multi-client service. Pi's internal detached-child helpers are not a public import surface.
- `pi-atelier/src/sidebar.ts` width-aware rendering and `desktop-notifications/core.ts::createQualityAttentionTracker`: preserve existing presentation plumbing.
- `vscode-languageserver-protocol/node::createProtocolConnection`: maintained stdio JSON-RPC implementation; add explicit runtime dependencies and verify the actual Pi loader.

## Steps

- [x] **Establish compatibility first:** select/pin server versions and dependency versions; build isolated protocol probes proving fresh compiler/analyzer/suggestion diagnostics and process cleanup for C#, TS/JS, Python, Rust, and Go. Resolve compatibility blockers before broad integration.
- [x] **Project setup:** implement strict private profiles, worktree/non-Git root resolution, draft activation, guided approval, managed installations, doctor/status commands, and concurrent setup/install tests.
- [x] **Shared runtime:** implement authenticated broker discovery, atomic startup, live client leases, centralized LSP transport/document generations/watchers, background attach/warmup, shared restart, and last-client shutdown/abnormal-exit handling.
- [x] **Shared gate:** extend case evidence/persistence with backward loading, attach post-edit feedback, finalize LSP-first at batch boundaries, and reuse round counting, scope, recovery, and arbitration without fabricating model proposals.
- [x] **Presentation:** extend quality status events, compact wrapping server labels, aggregate badges/counters, and setup/recovery attention notifications. Preserve existing behavior when LSP is unconfigured.
- [x] **Verify and document:** run fake-server and real-preset checks, two-instance lifecycle tests, old-case recovery tests, actual Pi-loader/package checks, and TUI smoke tests. Record latency and compatibility limits.

## Verification

### Deterministic tests

- **Protocol:** delayed initialization/registration; multiple compiler/analyzer/suggestion providers; full/unchanged pull reports; push clearing events; late findings after empty notifications; URI/Unicode positions; new files; missing projects; stale/out-of-order replies; cancellation; server output overflow; rejection of workspace edits/unknown commands.
- **Freshness/concurrency:** two clients editing one file, parallel edits to related files, stale-hash requests, deduplicated checks with independent cancellation, project-settings changes, watcher invalidation, and tree/reload/profile/broker/server generations. Never overwrite current disk content with an older client's overlay or return an old clean result for new content.
- **Shared cases:** parameterize Error, Warning, Information, Hint, and omitted severity; each blocks, including pre-existing diagnostics. Lowering severity does not bypass the gate. No model call while any diagnostic remains. LSP-clean then readability rejection uses the same budget; one counter increment per finalized pass; five unsuccessful responses reach arbitration; final-round approval closes normally; disagreement reruns diagnostics; infrastructure failures consume no round. Cases/approvals never leak across Pi clients.
- **Operator choices:** no-proposal arbitration; exact readability patch followed by a warning/hint; correction scope expansion; source-specific waiver versus whole-case acceptance; no approval on cancelled dialogs or stale snapshots.
- **Persistence/configuration:** read v1 cases and counters; two setup writers conflict safely; interrupted installation never becomes active; identical checkout/config shares one LSP; different worktrees or server settings do not. Test non-Git ancestor resolution, multiple roots/solutions, invalid config/missing SDKs, and readability-only behavior for unconfigured types.
- **Broker/processes:** simultaneous startup creates one server; creator disconnect leaves it running; last detach shuts it down; last-client crash releases its lease; last-detach/new-attach races never duplicate a generation. Test stale registry/socket recovery, failed spawn, unresponsive shutdown, descendants, broker failure, coordinated retries/restart, reload/session replacement, and guard cleanup. No lingering broker/guard/LSP after the last client exits.
- **UI/package:** replayed shared state and client counts; per-client queued/checking status; multiple server names, per-route failures, narrow widths/Unicode, unchanged model identity, stable counters, attention notifications, independent package loading, and standalone broker/guard launch.

### Real-server and manual acceptance

Use installed, explicitly approved server versions; normal unit tests never download tools or contact model providers. Preset probes use isolated fixture projects and must pass for all advertised languages before release. Doctor checks the real project without inserting synthetic errors into user files.

For each preset, demonstrate syntax/semantic and available non-error findings, repair to clean, clean-to-clean changes, creation of a new file, and stale-result rejection. Record cold readiness, warm check p50/p95, and two-client queue latency on named fixtures/hardware. Confirm Rust check-on-save and large C# solution behavior rather than claiming universal subsecond performance.

In TUI: configure C# and TypeScript routes, observe warming/ready/checking/shared-client labels, and trigger warning-only and hint-only correction loops. Open two Pi instances on the same checkout and prove they report the same broker/server generation with exactly one LSP process. Quit or kill the creator; the other instance must continue checking. Close the last instance; broker/guard/LSP must exit. Repeat with reload, simultaneous startup, and a separate worktree; confirm the worktree has its own LSP. Exercise operator arbitration and confirm an unconfigured project behaves as before.

Run the existing package scripts and root checks after implementation:

```sh
bun run --cwd code-quality test
bun run --cwd pi-atelier test
bun run test:integration
bun run typecheck
bun run lint
bun run format:check
bun run check:pack
bun run check
```

Finally load the independently packed quality extension through Pi's actual loader, not only the test runner. Real-server probes and any live-model smoke calls remain explicit opt-in checks.

## Research references and limits

- [LSP specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/): synchronization, diagnostic providers, progress, cancellation, and shutdown contracts.
- [Microsoft Node protocol transport](https://github.com/microsoft/vscode-languageserver-node/blob/main/protocol/src/node/main.ts): client-side stream connection without a VS Code host.
- [Official Roslyn server](https://github.com/dotnet/roslyn/tree/main/src/LanguageServer/roslyn-language-server): stdio/project-loading options and dedicated versus shared-daemon behavior.
- [TypeScript diagnostics implementation](https://github.com/typescript-language-server/typescript-language-server/blob/master/src/diagnosticsManager.ts) and [documented protocol bridge](https://github.com/typescript-language-server/typescript-language-server#send-tsserver-command): reasons to test completion rather than assume an empty push is clean.
- [rust-analyzer LSP extensions](https://rust-analyzer.github.io/book/contributing/lsp-extensions.html): server state and flycheck lifecycle.
- [pi-hooks LSP reference](https://github.com/prateekmedia/pi-hooks/tree/main/lsp): useful lifecycle reference, not a dependency or proof of this gate's freshness guarantees.

## Execution results

- With explicit operator approval, installed pinned servers and private validation-only Go/Rust toolchains under Pi storage. No system SDK/PATH changes or real-project LSP activation.
- Completed fake-server, shared-case, profile/install, broker lifecycle, packed-loader, and real-Pi write-result tests. Full root `bun run check` passed, including all package tests, integration tests, typechecks, lint, formatting, and pack verification.
- Ten opt-in real-server tests passed on macOS arm64: full fixture sequences and production clients for C#, TS/JS, Python, Rust, and Go. See `code-quality/lsp-compatibility.md` for exact versions and fixture measurements.
- Automated fullscreen pseudoterminal smoke passed with two actual Pi instances and Atelier: shared ready LSP, creator shutdown, status, reload, and final cleanup. No broker/guard/LSP processes remained. Human visual inspection was not performed.
- Custom-server support is intentionally limited to pull diagnostics; recognized presets handle their required protocol extensions. Linux/WSL, large/multi-target solutions, arbitrary third-party analyzers, and production contention remain unverified on this machine. Workspace change detection is not an atomic filesystem lock; deliberately detached daemons or simultaneous uncatchable broker/guard termination are outside cleanup guarantees.
