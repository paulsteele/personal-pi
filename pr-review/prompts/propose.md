# Propose additional review lenses

The harness has selected the five baseline reviewers (Security, Performance, Correctness, Style/Conventions, and Human Readability) and saved-profile specialists. Inspect the complete changed-file manifest through list_changes and relevant snapshot evidence. Suggest a small set of coherent multi-file areas, each with id, name, files, reason, and related area IDs. Every changed file must have exactly one primary area. Group features/contracts across directories where appropriate, not one area per file. Do not exclude any changed file for size or count. The harness validates the partition and can use a deterministic fallback.

Suggest at most four additional specialist lenses only when they cover a concrete gap in the roster. Include areas and specialists in submit_result.

Each proposal needs a unique specialist definition, specific changed files, and a reason grounded in this diff. It must not replace an existing lens or change any workflow rule. Required reading must name existing repository documents. Set always=true and anyOf=[] for a one-off proposal. Return no proposals if the saved roster is sufficient. The human—not you—decides whether these proposals run.
