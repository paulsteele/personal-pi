# Human readability

Review how easily a human can understand both the resulting code and the captured diff. Own the whole change: follow entry points, callers, and related hunks to understand the high-level purpose before judging local details. Focus on introduced obstacles to understanding, not personal style preferences or unrelated cleanup.

## High-level intent and accurate names

- Check that the main flow communicates what the code accomplishes, with coherent responsibilities and visible data flow, state transitions, and side effects. Identify places where a reader must reconstruct intent from low-level mechanics or repeatedly jump between fragments.
- Check variable, parameter, and function names against their actual meaning and behavior. Names should accurately convey relevant domain roles, units, lifecycle state, boolean conditions, return values, and side effects. Flag misleading or materially ambiguous names, not merely short names or a preference for different synonyms. Verify declarations and call sites before proposing a rename; respect public API compatibility and established domain vocabulary.

## Named operations instead of temporal narration

- Prefer cohesive, intent-revealing named functions when a procedural block's purpose is otherwise carried only by temporal comments such as "first", "then", "now", or "finally", or by narration of how the code used to work. A name such as `selectEligibleReviewers` explains a responsibility better than `processStepTwo` or a "next, filter these" comment.
- Recommend extraction only when it gives a meaningful operation a clear name and makes the caller easier to follow. Keep inputs, outputs, ordering dependencies, and side effects apparent. Do not demand a helper for every block or small callback, scatter tightly coupled logic, or introduce indirection that makes understanding harder.
- Preserve useful comments explaining why, invariants, tradeoffs, external constraints, or necessary ordering. Do not replace those explanations with names that merely restate the mechanics, and do not treat temporal wording alone as a finding.

## Reviewable diff hunks

- Compare old and new code as well as the final source. Check whether a reviewer can locate the behavioral change, understand its intent, and connect related edits without mentally undoing unrelated changes.
- Look for avoidable reformatting, reordering, moves, renames, or unrelated refactors mixed into behavioral edits that materially obscure what changed. Prefer focused changes and stable surrounding structure; suggest a concrete local restructuring or removal of unnecessary churn when it would expose the semantic delta.
- Optimize for understanding, not the fewest changed lines or an arbitrary hunk-size limit. Necessary refactors, generated changes, and repository-required formatting are not inherently problems. Do not sacrifice coherent code or hide relevant changes to shrink a diff. Judge only the captured patch; do not infer unseen commit history or prescribe history rewriting. Repository-wide concerns still need a representative changed-hunk anchor and supporting evidence.

## Finding threshold

Report a specific misleading interpretation or demonstrable review/maintenance burden, quote the evidence, and propose the smallest practical improvement. A concrete readability regression can be actionable without a runtime failure; do not invent a behavioral bug to justify it. Normally use low severity unless independently demonstrated impact warrants more. If names, structure, or hunks are already understandable, return no finding rather than offering a cosmetic alternative. Leave convention compliance to Style/Conventions and broad design alternatives to Architecture / Integration.
