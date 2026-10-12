# Project locations

Shared identity and private profile path helpers for PR review, language-server setup, and the sandbox.

Git identities are SHA-256 hashes of the canonical Git common directory. Linked worktrees share an identity but retain their distinct canonical checkout roots. Independent clones have distinct identities. A caller can provide its own Git runner to retain hardened execution behavior.

Non-Git projects use the closest ancestor accepted by the caller's profile-existence predicate, or the canonical startup directory when no configured ancestor exists. Profile schemas, approval, publication, and access grants remain caller-owned.

`projectStoragePath` places a relative profile path under `<storage-root>/{repos|projects}/<id>/`. Location resolution and profile paths do not grant filesystem or execution authority. This package has no Pi extension entry point.
