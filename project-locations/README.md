# Project locations

Shared identity and private profile path helpers for PR review, language-server setup, and the sandbox.

Git identities are SHA-256 hashes of the canonical Git common directory. Linked worktrees share an identity but retain their distinct canonical checkout roots. Independent clones have distinct identities. A caller can provide its own Git runner to retain hardened execution behavior.

Non-Git projects use the closest ancestor accepted by the caller's profile-existence predicate, or the canonical startup directory when no configured ancestor exists. Profile schemas, approval, publication, and access grants remain caller-owned.

`projectStoragePath` places a relative profile path under `<storage-root>/{repos|projects}/<id>/`. Location resolution and profile paths do not grant filesystem or execution authority. This package has no Pi extension entry point.

## Tests

Git-backed fixtures use the shared [`tests/git-fixture.ts`](../tests/git-fixture.ts) runner. It supplies an identity for every command, ignores developer/system Git configuration and inherited `GIT_*` overrides, disables signing and hooks, and gives each subprocess a two-second deadline. Reuse it when adding real Git fixtures rather than relying on the developer's machine configuration.
