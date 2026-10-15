# Changelog

## 2.4.0 — 2026-10-15

- Add a session-scoped sandbox escape hatch: `/sandbox off|on`, the Settings → Sandbox → General toggle, the `--no-sandbox` launch flag, and `PI_SANDBOX=off`. While off, the devcontainer is retired and built-in file tools, Bash, and `!` user shell run on the host in the session cwd. Explicit tool, path, and shell denies still apply, and mount and tool-installation requests are refused. The choice persists across `/reload` and resume of that session only; new sessions start sandboxed. Sidebar and quality observe the new `off` presentation phase.
- Pin the private .NET support for Roslyn to SDK 10.0.109 (runtime 10.0.9), which fixes SIGILL crashes (exit code 132) on ARM64 VMs that expose SME without SVE, such as Podman on Apple M4/M5. Existing tool profiles pinned to `dotnet-runtime` 10.0.102 must change that entry to `{"kind":"catalog","version":"10.0.109"}` in Global Sandbox Tools, followed by the normal approved rebuild.

## 2.3.0 — 2026-10-15

- Add checksum-pinned jscpd 5.4.1 Linux GNU/musl ARM64/x86-64 artifact recipes, a distinct quality-tool role, and a runtime version check.
- Include jscpd in newly created default tool profiles without silently extending existing approved profiles or changing required language-server membership.

## 2.1.0 — 2026-10-13

- Save every accepted Settings edit immediately without Apply/Done buttons; General Settings edits also migrate legacy policy without a separate setup command. Manual settings edits retain separate mount, initialization, and rebuild authorization.
- Remove `/sandbox host-commands`; authorize native rules through direct private-file edits or Project Host Commands in Settings. Saving the file or accepting a Settings edit is the only authorization step.
- Remove built-in model configuration proposals and Container Base generation actions. Base setup opens the manual editor directly; retain standalone setup approval and the main agent's approved tool-installation workflow. Accept and strip the retired `modelAssistedSetup` field when loading/saving existing settings.
- Show only loaded tooling configuration paths in the Sandbox tab and status while retaining missing-path tracking for provisioning validation.

- Report real startup stages; hide machine-readable inspection output, summarize cached build steps, and label reused artifacts by tool/version.
- Save owner-only, unredacted per-operation diagnostic logs with full output chunks in TUI, RPC, and headless modes. Expose the latest path with `/sandbox logs` and status, retaining failed-attempt logs.
- Batch runtime executable availability checks and reuse the already resolved builder image without removing image-isolation, runtime-version, or read-only mount verification.

## 2.0.0 — 2026-10-12

- Stop session devcontainers with zero graceful-stop delay and a separate 15-second command timeout across rebuilds, mount recreation, rollback cleanup, and shutdown. Retain container-specific Podman failure diagnostics; make mount checkpointing cancellable and report stopping separately from checkpointing.

- Keep mount-change and rebuild progress screens alive across container-generation retirement. Their cancellation now follows the session and requested operation rather than the guest processes being stopped; report mount-update completion after the replacement is ready and saved.

- Remove sensitive-file, external-effect, and unresolved-shell-path approval prompts from guest tool review and native host-command dispatch. Retain explicit denies and separate host-access/provisioning authorization.
- Leave dynamic/escaped executable names, opaque shell payloads, and function definitions/calls in guest Bash instead of rejecting them when host rules exist. Continue routing separately matched literal host commands; pass incomplete parser input unchanged to guest Bash without partial routing.

- Remove tests that require creating nested Podman containers. Retain the engine-contract, lifecycle, native-shell, and Python-process tests that run in the container. This change does not verify compatibility with a live engine.

- Resolve selected devcontainer configuration through the pinned CLI without contacting Podman or executing initialization. A configuration-only engine adapter reports no existing containers and rejects all other operations; build/startup retain their authorized engine adapter.
- Validate build inputs against the actual agent private-storage root when environment layers are not requested, rather than deriving a false boundary beneath the selected definition. Restore JSONC/substitution and project Containerfile/context resolution tests.

- Remove disposable reviewer containers with zero graceful-stop delay and a separate 15-second command timeout.
- Ignore already-removed containers; retain Podman stderr and termination details, along with both transport and removal failures.

- Give each logical PR worker a dedicated read-only, network-disabled container from the prepared image and a persistent path-only probe transport. Retain individual live worker source checks.
- Await cleanup on completion, cancellation, and parent sandbox retirement. Recreate failed transports only on explicit retry.
- Keep 32-source batches for host preparation and output.

- Batch source mappings into one guest probe per delegated action and reuse the validated canonical path for policy checks. Propagate review cancellation, bound canonical probes to ten seconds, and authorize deleted historical paths through approved canonical parents without weakening mount or path-deny checks.

- Group sandbox settings under one plugin root and style the fullscreen startup console with a themed frame, current/previous stage, labeled logs, and live-follow status. Retain compact tiny-terminal rendering and approval/lifecycle behavior.

- Contribute settings sections for Sandbox, project host commands, tool profiles, and the environment.
- User Apply authorizes private host rules; existing rebuild approvals and mandatory sandbox boundaries remain unchanged.

- Add manually authorized private project host-command rules for exact scripts and named executables with unrestricted arguments. Route agent/user Bash through a Tree-sitter rewrite and supervised native argv bridge; guest Bash retains chains, pipes, redirects, and expansion.
- Show the profile with `/sandbox host-commands`. Recheck live rules and mapped cwd, preserve explicit denies, and cancel native processes on timeout, shutdown, or recreation. No automatic host fallback or agent-generated host grants.

- Retain complete fallback and repository base definitions while storing private project requirements separately. Build reusable language-server and runtime images, then add project installations without rewriting the base definitions.
- Add pinned recipes for all five language servers on Debian, Ubuntu, and Alpine. Probe linked-copy support, track installed tools, and bound image-build time. Publish requested project tools after a successful candidate build. Real-container platform and cache verification remains pending.

- Bound post-install executable probes to ten seconds and guest-process termination to five seconds. Keep installation progress visible through verification and report distinct rebuild completion and probe stages.

- Remove superseded containers after successful generation replacement; automatically prune unlocked, stopped session containers after seven days of inactivity on sandbox startup. Retain host files and mount grants for fresh-container resume, and leave images for manual cleanup.

- Load validated devcontainer definitions without per-session approval prompts; retain separate host bind, host initialization, and port forwarding approvals.
- Add model-only `request_sandbox_tool` for approved, pinned development-tool installation layers in the active definition, with global-impact previews, runtime executable probes, and image rebuild rollback.

- Replace the loaded auto-mode entry point with mandatory Podman devcontainer tools, private worktree-aware definitions, current-model setup proposals, and session-resumable host bind approvals.
- Add project-linked container names/labels, guarded reference-CLI execution, guest filesystem/process transport, local checkpoint recreation, and loopback forwarding.
- Retain best-effort sensitive/external-effect and explicit-deny checks; remove live auto commands and host tool fallback. Historical permission/classifier source remains for migration regression tests.
- Allow `ask_user_question` from the audited `@juicesharp/rpiv-ask-user-question` npm entry point as host UI without requiring a ready container. Preserve explicit denies and reject lookalike tools from other sources.
- Authorize the four `pi-web-access` tools and Plannotator's viewer/plan tools from their npm entry points without additional sandbox prompts or container readiness. Retain host-side package behavior, explicit tool denies, cancellation, and unknown-tool rejection; document that internal file/process/credential operations are not container-isolated.
- Expose trusted image-tool proposals for quality setup: extend the active devcontainer build with pinned server layers, preserve topology and runtime settings, roll back build failures, and save rebuilt definition revisions for resume.

## 1.5.0 — 2026-09-29

- Correlate LiteLLM classifier calls, retries, and delegated PR permission checks in a separate per-Pi auto log session, without changing main-model or cache/routing identities.

## 1.4.2 — 2026-09-28

- Use SDK types for classifier calls and settle cancellation/timeouts even when a provider ignores abort. Preserve one deadline across malformed-response retries and prevent late results from approving cancelled actions.

## 1.4.1 — 2026-09-25

- Add a trusted delegated local-search check that defers ordinary approval until matching content is disclosed. Explicit denies, sensitive-path guards, external-path restrictions, cancellation, and live policy remain enforced before scanning.
- Distinguish local-search audit decisions from disclosure approvals; keep ordinary reads and skill invocation unchanged.

## 1.4.0 — 2026-09-24

- Align the workspace with Pi 0.87.x and verify against 0.87.1 development dependencies. Permission rules and classifier authority are unchanged.

## 1.3.0

- Remove edit bodies from classifier input and explicitly scope edit/write review to file-modification authorization using operation, paths, and user intent. Keep bounded edit previews for human approval, Bash command evidence, and deterministic path/safety checks unchanged.

## 1.2.0

- Share the context-explicit tool evaluator with a versioned parent-owned PR permission service. Apply current global policy/auto mode, preserve main-agent and isolated worker-turn classifier memoization, and reject stale in-flight decisions without removing explicit session grants.
- Serialize main/child human prompts with cancellation and delegated provenance. Keep guards human-only, validate all declared source effects/skill paths, and show paths even when a tool-level ask wins policy selection.

## 1.1.2

- Accept trusted extension session-file grants for exact canonical report paths at the external-directory boundary. Keep grants in memory, reject invalid/stale events, clear them on session teardown/reload, and preserve other policy and deterministic guards.
- Preserve resolved path facts through classifier routing and scope the `/tmp` guidance to destinations within the canonical temp root. Keep ordinary external symlink targets on the original prompt, including dangling write destinations, without changing policy or human-only guards.
- Add risk-based log guidance only to external-directory classifier reviews of `/tmp` and its descendants. Keep the original classifier instructions for all other paths and operations, including other temp directories; preserve model review (no `/tmp` allowlist), explicit user restrictions, policy denies, and deterministic safety guards. Add scope, prompt-contract, and permission-routing regressions.

## 1.0.8

- Resolve dangling symlink destinations when canonicalizing paths, preserving sensitive-target guards even when the target does not yet exist; add path and permission-system regression coverage.

## 1.0.7 — 2026-09-11

- Exempt the exact `.env.example` basename from the env-credential filename guard so normal permission rules apply to templates. Preserve protected credential directories, sensitive symlink targets, other env filenames, and high-impact command guards; cover file tools and Bash with regression tests in auto and manual modes.

## 1.0.5 — 2026-09-03

- Route unresolved path-bearing shell expansions through the auto classifier as an explicit risk marker, including when generic Bash policy allows the command; retain direct human review when auto mode is off and preserve stronger deterministic guards.
- Add `Allow directory for session` to external-directory approval prompts; grant the canonical directory and its descendants in memory until session end without changing global policy or broadening to a parent.
- Retry malformed classifier output up to twice with an explicit tool-call repair instruction before escalating to human approval, while retaining the original operation deadline and fail-closed behavior.
- Simplify the armed auto-mode footer status to `⏵⏵ auto`; detailed allow and human-ask counts remain available through auto-mode events and Atelier Activity.

## 1.0.3 — 2026-09-01

- Closed Bash compound-command safety gaps by projecting `for`/`select` iterables, filesystem test operands, and statically resolvable local scalar bindings through control-flow scopes.
- Preserved whole compound units while enumerating executable descendants, so deterministic command guards and explicit Bash policy denies cannot be hidden inside loops, conditions, case arms, groups, or function bodies.
- Added a fail-closed human guard for path-bearing shell operands whose expansions remain unresolved, before classifier review.

## 1.0.2 — 2026-08-31

- In human review prompts, color Tree-sitter Bash command units covered by deterministic `allow` policy with the policy color, while leaving unresolved units and the reviewed action warning-colored. This is presentation-only and does not change classifier inputs or decisions.

## 1.0.1 — 2026-08-28

- Established a source-owned personal fork from `pi-permission-system-v26.3.1`.
- Imported the hardened deterministic tool-call guard work as the migration baseline.
- Recorded rollback material, previous patch checksum, and pre-cutover green baselines in `FORK.md`.
- Integrated auto review, single-selection one-shot human decisions, branch-local classifier notes,
  fixed global configuration, bounded redacted review logging, and correlated decision events.
- Retired the old npm/patch and loose-auto runtime artifacts to the rollback snapshot after isolated
  fork and Atelier checks passed.
- Enforced explicit skill invocation and skill-directory reads, matched path policies against
  canonical aliases, restored classifier request/environment context, propagated cancellation,
  protected invalid configuration from overwrite, and removed raw decision text from review logs.
- Restored rich permission request facts with warning-highlighted command/path evidence and bounded
  edit previews.
- Narrowed classifier authority to allow-or-require-human and changed every positive deterministic
  safety match to fresh human approval; explicit policy deny remains terminal and headless escalation
  remains fail-closed.
- Persisted bounded permission requests and correlated human outcomes as TUI-only transcript entries,
  leaving a compact decision-control panel and the full conversation scrollable. Shared Atelier's
  `󰚩` classifier, `󰀄` human, and `󰒃` security/policy provenance glyphs and replaced auto-deny
  accounting with classifier allow/human-asked counts.

