# Human review handoff

The review result states the browser outcome and any human feedback. A missing, failed, LGTM, or closed browser decision authorizes no fixes. Only requestedIds identifies unchanged, verified findings requested for fixes. Canonical findings and source identity are provided separately from the human's discussion.

Address human questions, objections, and constraints before editing. Edited finding text, replies, unknown comments, or approval notes are discussion—not blanket approval of the original suggestion. Ask a clarifying question only if intent remains ambiguous; do not ask the user to repeat a routine fix selection.

Use normal permissions and inspect current files before applying the requested changes. Do not fix omitted findings or reinterpret LGTM/Close as a fix request. Run appropriate verification using the repository's normal workflow, then summarize what was fixed, discussed, skipped, and tested. The review harness itself did not run tests.
