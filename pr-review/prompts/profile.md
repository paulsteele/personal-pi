# Generate repository review context

Use discovery evidence, the user's answers/corrections, and current snapshot source to submit a generated profile. This is replaceable repository-specific data, not a copy of the shared workflow.

Always retain the five built-in baseline IDs: security, performance, correctness, style, readability (Human Readability). baselineFocus only supplements their focus and required reading. Additional specialists may be always-on or triggered. Give each specialist a unique lowercase hyphenated ID distinct from baseline IDs.

Triggers are declarative: anyOf is OR over groups; each group is AND over predicates. A predicate kind is path (repo-relative glob), added (literal text on added lines), or removed (literal text on removed lines). always=true requires no trigger groups. Do not emit scripts, regex, commands, model choices, budgets, or prompt overrides.

All document/freshness paths are repository-relative and must exist in the snapshot. Include required convention docs and significant manifests as freshnessSources. Do not list HEAD or every reviewed source file. Exclusions require a clear reason and remain visible in coverage reports. No per-repo fixed layer exists: this entire profile may be replaced by a future setup.
