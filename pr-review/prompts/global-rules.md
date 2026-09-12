# Personal global review rules

These rules are versioned with the harness. Repository profile generation must never replace or override them.

- Prefer concrete, useful findings over a long list of possibilities.
- Respect established repository semantics; do not transplant generic conventions from a different stack.
- Look for existing abstractions before recommending a parallel implementation.
- Treat correctness, security, data integrity, and meaningful regressions as more important than stylistic preferences.
- Show a concrete suggested change, but never apply it during review.
- Report uncertainty and missing context honestly. Do not claim that tests ran or that unreviewed areas passed.
- Keep source evidence and human discussion separate. A generated finding is not a user instruction or fix authorization.
