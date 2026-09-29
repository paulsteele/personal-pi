# LSP compatibility probes

## Verified environment

2026-09-28–29: macOS arm64, Node 26.8.1, .NET SDK 10.0.102. Private Go 1.27.1 and Rust 1.98.1 toolchains were installed with explicit operator approval. No project LSP profile was activated.

| Server | Pinned version | Diagnostic completion strategy |
| --- | --- | --- |
| TypeScript language server | 6.0.1, TypeScript 5.9.3 | Its LSP `typescript.tsserverRequest` command returns synchronous syntactic, semantic, and suggestion reports. Do not use its empty clearing pushes as completion. |
| Pyright | 1.1.414 | Dynamically registered pull diagnostics, including hints such as unreachable code. |
| Roslyn language server | 5.12.0-1.26426.8 (prerelease) | Explicit `project/open`, `workspace/projectInitializationComplete`, non-miscellaneous project membership, and all applicable registered diagnostic providers. |
| gopls | 0.23.0 | Enable `pullDiagnostics`; document pulls include compiler and analyzer findings for Go source files. |
| rust-analyzer | 1.98.1 (48a229ce) | Pull native diagnostics and combine rustc push diagnostics after an explicitly requested flycheck begins and ends. Requires the matching Rust source component. |

The Node protocol dependency is `vscode-languageserver-protocol` 3.18.4. TypeScript language server 6.0.1 requires Node >=22.22.2; setup must validate that independently of the extension's existing Node >=22.19.0 requirement.

## Probe results

All five servers passed the following sequence on isolated projects:

1. Existing file with a semantic error.
2. Repair to zero diagnostics.
3. Introduce a syntax error.
4. Replace it with valid code producing a warning or hint, with no error-severity findings.
5. Repair again, then five clean-to-clean changes.
6. Create a new file with a semantic error and repair it.
7. Clean LSP shutdown; inspect for leftover server/build-host processes.

The deterministic fake server tests retain Error, Warning, Information, Hint, and unspecified-severity reports even when an empty clearing notification arrives first. These tests cover the protocol adapter. Additional production-client, broker, quality-controller, and real-Pi tests exercise the integration described below.

One observed warm-clean run, five samples per server:

| Server | First diagnostic response from process start | Warm-clean median | Warm-clean maximum |
| --- | ---: | ---: | ---: |
| TypeScript | 247 ms | 1.6 ms | 1.9 ms |
| Pyright | 487 ms | 2.3 ms | 3.3 ms |
| Roslyn | 1,580 ms | 45.7 ms | 58.1 ms |
| gopls | 827 ms | 3.8 ms | 4.6 ms |
| rust-analyzer | 2,894 ms | 189.8 ms | 231.1 ms |

These tiny-fixture measurements include file synchronization and diagnostic collection for warm samples. They are not production latency estimates or statistically meaningful p95 results. Large solutions, third-party analyzers, dependency changes, and broker contention remain unmeasured.

## Integration requirements revealed by the probes

- **Roslyn auto-loading is not sufficient readiness evidence.** Some attempts emitted a loading-progress end without project initialization or semantic diagnostics. Explicit project opening and the initialization notification were reliable in repeated probes. A newly created file initially belonged to Miscellaneous Files and returned no semantic errors; wait for actual project membership before accepting diagnostics. Do not infer correctness from empty reports during loading.
- **Roslyn suggestions require the analyzer providers.** The unnecessary-using diagnostic arrived as Hint from an analyzer source. Compiler-only requests miss it.
- **Rust has two diagnostic channels.** Native pulls did not contain rustc's unused-variable warning. Request flycheck explicitly with automatic check-on-save disabled to avoid overlapping generations, wait for its begin/end, then combine native pulls with the corresponding pushed rustc results. Production integration must track all relevant workspace check tokens, failures, and cancellation, not only the single-workspace fixture.
- **Shutdown parameters matter.** Send the parameterless shutdown request without `null` positional arguments. Both Roslyn and rust-analyzer rejected the incorrectly shaped request during early discovery.
- **A clean launcher exit does not prove descendant cleanup.** A Roslyn MSBuild host remained after its launcher exited. Probe teardown checks and terminates the owned process group. The production broker/guard must retain group ownership until descendants are retired.

## Integrated verification

The production diagnostics client passed all five real-server broken/non-error/clean scenarios. The full protocol sequences and production-client tests run together as ten opt-in tests. gopls 0.23.0 returns an empty `kind` discriminator for full reports; the adapter accepts that shape only for the gopls preset.

Deterministic tests cover all severities in the shared correction gate, missing coverage after a pending check, restored cases/counters, LSP-only waivers, no-proposal arbitration, and fresh checks after an approved readability patch. A real Pi session verifies that a warning appears in the successful write result, the agent fixes it, and only then the readability reviewer runs.

Broker tests cover simultaneous attachment, stale hash rejection, shared cancellation ownership, coordinated restart, creator-process death, and last-client retirement. A packed-tarball test loads the extension through Pi's resource loader and launches its standalone broker using only declared dependencies.

An automated pseudoterminal smoke run started two actual fullscreen Pi processes with Atelier and an isolated fake-server profile. Both showed the same shared server with `×2`; closing the first left the second usable. Status, reload, and final shutdown completed without logged extension errors. No broker, guard, server, or build-host processes remained. This was an automated terminal run, not a human visual inspection.

## Running the probes

```sh
bun run --cwd code-quality test
bun run --cwd code-quality typecheck
bun run --cwd code-quality test:lsp-compatibility
bun run --cwd code-quality test:lsp-tui
```

Normal tests skip real-server execution. `test:lsp-compatibility` explicitly enables it and expects the approved private tool layout in `lsp-compatibility.test.ts`; `QUALITY_LSP_TOOL_ROOT` overrides the base directory. It never installs servers. Fixtures and raw traces are retained under the private Pi quality compatibility directory for inspection.

The real-server and TUI runs were performed on macOS arm64 only. Linux/WSL validation, large/multi-target solutions, third-party analyzers, production contention benchmarks, and arbitrary custom servers remain unverified. The TUI smoke command requires Python 3 and a `pi` executable and retains temporary terminal/event logs for inspection. Custom servers must supply reliable pull diagnostics; push-only custom servers are refused rather than accepted after a silence timeout.
