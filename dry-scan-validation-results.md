# DRY baseline implementation validation

## Implemented

- Lexical index features and evidence signals share a 160-character contract, including prefixes. Oversized identifiers, words, calls, and literals retain their family and a SHA-256 digest of the full normalized value; reserved digest-shaped literal inputs are hashed too.
- The supervised persistent baseline worker prepares revision-scoped artifacts once. The manager reads manifest, report, and lexical shards through the existing sandbox filesystem service. No new interactive process API or agent-visible jscpd tools were added.
- Each shard is at most 512 KiB, with declared size and digest validation. Lexical records span shard boundaries, so a valid source is not discarded merely because its index exceeds one shard. Initial and incremental exports validate manifest/report revisions, file metadata, uniqueness, and completeness before acceptance.
- One deadline covers the whole baseline build/update, with cancellation and generation/worker ownership checks. Status reports the current phase, total duration, phase timings, analyzed/indexed file counts, and lexical transfer bytes/shards.
- Unchanged turns export nothing. One-file changes and deletion-only updates preserve incremental transfer behavior.

## Mounted-checkout measurements

Read-only checkout: `/workspaces/cgm`, corresponding to `/Users/ptsteele/projects/rdc/CgmMobileApp/main`.
Read-only saved profile: `/workspaces/cgm-dry-profile.json`; exclusions remain `packages` and `lib/packages`.
Linux arm64 guest; managed jscpd 5.4.1 and Node 24.21.0. No provider calls.

The actual `SandboxDryManager` ran against a **local subprocess/filesystem adapter inside the guest**. These are not real host-to-container Podman transport timings.

| Measurement | Initial | Fresh rebuild | Unchanged turn |
| --- | ---: | ---: | ---: |
| Ready | Yes | Yes | Yes |
| Eligible files / bytes | 2,777 / 10,041,161 | Same | Same |
| Detector-analyzed files | 2,497 | 2,497 | Same |
| Capture | 4,460 ms | 4,375 ms | 504 ms |
| Detector | 704 ms | 688 ms | 0 ms |
| Export preparation | 526 ms | 452 ms | 0 ms |
| Transfer/validation | 519 ms | 514 ms | 0 ms |
| Total baseline | 6,236 ms | 6,073 ms | 530 ms |
| Lexical bytes / shards transferred | 20,658,418 / 40 | Same | 0 / 0 |
| Guest execute operations | `serve`, `baseline` | `serve`, `baseline` | `update` |

The Countly 800-digit fixture now validates; the previous generic lexical-file failure no longer occurs. Source/profile/application files were not modified. Diagnostic directories were removed after measurement.

## Automated validation

- Full `bun run check` passes, including sandbox/package/integration suites, static checks, formatting, and packaging.
- Code Quality: 441 tests across 38 files pass.
- Regressions include oversized feature families and reserved digest inputs, a valid source with an index exceeding 512 KiB, a synthetic index exceeding 16 MiB with constant worker-launch count, changed/deleted exports, corrupt shards, malformed lexical output, revision/size mismatches, cancelled transfer, retired generation, and an overall timeout when the filesystem does not cooperate with cancellation.
- One earlier full-check attempt hit an LSP reload integration timeout. That test passed in isolation and subsequent full checks passed; no unrelated test change was made.

## Remaining field validation

Benchmark the real sandbox service on the operator host, recording cold/warm bind state, total transport latency, and peak memory. Guest-local results meet the proposed warm targets but are not a production latency guarantee. Reassess a persistent DRY RPC service only if filesystem shards leave material startup overhead or miss the measured target.

Revision-scoped lexical search caching and moving retrieval into the guest remain follow-ups, not part of this change. Earlier measured host retrieval cost was roughly 50–67 ms for one changed range and 1.1 seconds for twenty ranges; it was not established as the cause of the interrupted 248-second check.
