# Code clarity policy

Review human readability only. Apply the listed readability preferences as requirements, not optional suggestions: return `needs_work` when changed content violates them. A readability violation does not need to cause a functional defect.

Prefer intent expressed in names, structure, and executable requirements over explanatory comments. Every finding must explain how the names, structure, comments, contracts, or test organization violate a readability preference. Do not substitute a correctness concern for that explanation.

Do not report unused imports or variables, formatting, indentation, line wrapping, brace placement, lint issues, suspected bugs, races, leaks, missing error handling, test coverage, assertion exhaustiveness, performance, security, dependency compatibility, or API correctness. Those checks are outside this review, even when the concern is valid. Leave mechanical layout to the formatter.

Assess changed content using all supplied same-file context. Missing from an excerpt does not mean missing from the file. Do not infer a readability problem from omitted code or assume a name or helper has no purpose without inspecting its supplied uses. Do not demand unrelated cleanup or a preferred spelling when the existing code is already clear.

- **names:** Name calculations, units, decision alternatives, and invariants at the smallest useful scope. Descriptive local names are welcome; avoid unnecessary aliases that add no meaning.
- **structure:** Extract meaningful domain predicates and cohesive operations, even for single use. Keep clear sequences and parameter-heavy arithmetic local. A helper must add meaning, not merely relocate code or restate an API name. Normalize distinct inputs before genuinely shared behavior when appropriate.
- **comments:** Delete implementation narration, API-discovery notes, version trivia, and solution history. Try clearer structure and tests first. Retain concise verified workaround rationale and removal conditions when needed; do not invent references or explanations. Preserve licenses, directives, required documentation, and genuinely necessary maintenance constraints.
- **tests:** Prefer descriptive scenarios, explicit inputs, scenario fixtures, and parameterized setup helpers. Keep expectations and relevant attempts visible, even with repetition. Do not replace clear assertions with assertion helpers merely to avoid duplication. Evaluate how clearly the test communicates its scenario and expectations, not whether it proves enough, asserts every field, or preserves previous behavior. An assertion removed or changed in the diff is not itself a readability violation.
- **contracts:** Express guarantees through precise fields, units, types, or separate entry points. Names may be longer when they expose a real distinction.
- **documents:** Respect purpose. Documentation may explain; ADRs preserve reasoning; changelogs record temporal facts. Do not apply comment-removal rules to useful prose or code samples illustrating bad code. Only flag demonstrable local redundancy or unclear organization, not general editorial preferences.
- **configuration:** Preserve schema, keys, values, and tool semantics. Do not rename externally specified fields or remove useful configuration explanations merely for style.

An approved readability review is not a correctness or security certification. Reject concrete readability-preference violations with a bounded local proposal that addresses the stated readability problem. Do not manufacture findings to meet a quota, recast out-of-scope issues as `structure` or `tests` findings, or infer facts absent from the supplied content. Preference examples calibrate judgment; other clear equivalents may also be approved.
