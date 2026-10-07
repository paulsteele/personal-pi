# Self-contained PR-review results

## Context

PR review currently sends the parent agent to private report JSON even for small results. `reviewOutcome()` always requires a full-report read, while `renderReport()` omits browser feedback and discussion. Both command and tool paths publish `displayOutcome()`; tool `details` contains only identity/status/path and is not model-facing context. The exact-file session allowance solves only the external-directory gate, not ordinary Bash classification.

Goal: return everything necessary to discuss feedback or implement explicitly requested findings inline when it fits, with scoped pagination otherwise. Keep saved reports as audit artifacts, not the normal handoff interface. Do not broaden permission rules or fix authorization.

## Approach

### Shared model-facing result

- Define a versioned action payload with report identity, project, requested scope, baseline, HEAD, captured fingerprint, status, issues, context notes, excluded or unavailable files, browser decision, exact authorized IDs, complete browser feedback and discussion, and requested findings with their evidence and group membership. When substantive feedback or discussion is present, also include the full verified findings and design advisories as discussion context: free-text questions can refer to unselected findings or advisory IDs. Keep each original finding ID and each advisory's unverified label; included context and group membership do not authorize additional fixes.
- Serialize browser discussion as data, retaining reply identifiers, locations, edited text, and other supplied fields. Do not summarize away human constraints or reinterpret discussion as authorization. Apply existing redaction to every string, including nested discussion and evidence.
- Return an authorization header, the action payload, and a compact review summary in `content` for both `/pr` and `pr_review`. The summary retains finding titles, severities, locations, advisory labels, and usage totals; it need not reproduce the task or verification ledger. Leave `renderReport()` and the saved audit format intact.
- Include model-visible `actionComplete` and retrieval instructions. A complete action payload needs no filesystem read. If it does not fit, return a clearly incomplete preview and require paging the complete action section before editing or resolving feedback. Optional omitted diagnostics do not make the action payload incomplete.
- Budget the complete returned text against 50 KiB and 2,000 lines, reserving space for the authorization header, completeness metadata, and retrieval instructions before optional summaries. Never let `displayOutcome()` silently cut required content after completeness has been calculated. Large ID lists, feedback, or individual findings must be recoverable without being mistaken for complete data.
- Preserve report ID, status, path, completeness, and retrieval metadata in `details` for rendering. Do not rely on `details` or `structuredContent` to deliver information to the model. The report path is explicitly an optional audit locator, not an instruction to read it.

### Scoped overflow retrieval

- Add `pr_review_result` as a read-only direct tool with `{ reportId, section: "action" | "report", cursor?: number }`. Declare the schema, units, and limits explicitly. `action` is the exact complete action JSON; `report` is the complete structured audit report without the redundant generated `markdown` field. No arbitrary paths, directory listing, historical lookup, project-source reads, or viewer launch.
- Return model-facing JSON containing report identity, section, text fragment, current character offset, total character count, and `nextOffset` (null at completion). Cursors count JavaScript string characters, consistent with existing review tools. Pages must make progress within the encoded output budget, preserve Unicode boundaries, and handle a single oversized record. Document that fragments are concatenated before interpreting the complete JSON.
- Maintain an in-memory registry of exact report files handed to this session, their repository identity, saved content revision, and conservative source dependency set. Use saved files as backing storage rather than retaining every full report or issuing general filesystem grants. Reject unknown IDs, mismatched identities, changed files, invalid cursors, and expired or retained-history-deleted reports with explicit errors; never fall back to another report.
- Register only after persistence, final source validation, and final parent-disclosure authorization. A late source-drift correction must rebuild the payload and registration from the corrected no-fix report. Failed or cancelled operations must not leave retrievable reports.
- Each retrieval opens a short-lived `openReviewPermissions()` operation attached to its real parent tool-call ID and authorizes the retained source dependencies with `PermissionScope.authorizeSources()` under a stable live revision before disclosure. Recheck freshness after awaited file work, honor cancellation and session expiration, and close the operation in `finally`. Denial or an unavailable service returns no report body. Being registered is identity/scope authority, not a cached source-access grant.
- Keep the current exact-file session allowance as optional audit-read convenience. Do not change the Permission System, classifier instructions, user configuration, or generic Bash permissions. The new tool does not promise zero approval prompts: normal tool and live source checks still apply; routine report filesystem reads and Python extraction are no longer required.

**Decision:** retrieval exposes only reports successfully handed to the current session. No historical browsing or arbitrary-path access. Registrations are memory-only and expire on session replacement, session shutdown, `/reload`, and `/tree`; no transcript or disk scan recreates them.

## Files to modify

- `pr-review/handoff.ts`, `pr-review/handoff.test.ts`: shared action type, redacted projection, compact summary, output budget, completeness, and retrieval instructions.
- New `pr-review/result-store.ts` and `pr-review/result-store.test.ts`: registered-report scope, saved revision validation, and section pagination.
- `pr-review/index.ts`, `pr-review/entry-handoff.test.ts`, `pr-review/index.test.ts`: both entry points, final dependency capture, registry lifecycle, retrieval tool, and permission integration. Update test harnesses to select registered tools by name rather than retaining only the last tool.
- `pr-review/prompts/fix-handoff.md`, `pr-review/README.md`: inline-first workflow, exact authorized-ID semantics, overflow protocol, and session expiration.
- `tests/package-integration.test.ts`: assert the additional tool registration.
- No changes planned to Permission System code, report storage schema, viewer selection logic, or worker tools.

## Reuse

- `reviewOutcome()` / `displayOutcome()` in `pr-review/handoff.ts`: shared command/tool handoff boundary.
- `redact()` / `renderReport()` in `pr-review/report.ts`: existing redaction and human-readable audit report; preserve report storage format.
- Group utilities in `pr-review/findings.ts`: preserve canonical/member relationships without expanding authorized IDs.
- `PermissionScope.authorizeSources()` and final parent authorization in `pr-review/permissions.ts` / `pr-review/index.ts`: live source-disclosure checks.
- `readStored()` in `pr-review/storage.ts`: validated exact-file reads and content revisions for registered saved reports.
- `read_task_input` in `pr-review/worker.ts` and `read_candidate` in `pr-review/runner.ts`: existing character-cursor pages with `nextOffset: null` termination; adapt the convention, not worker coverage tracking.
- Pi truncation constants/utilities: maintain the existing 50 KiB / 2,000-line result limits.

## Steps

- [x] Settle retrieval scope: current-session handed-off reports only.
- [x] Inspect existing character-cursor paging and permission lifecycle patterns.
- [x] Add the shared redacted action projection and compact summary; preserve explicit no-fix outcomes and existing command `triggerTurn` behavior.
- [x] Implement output budgeting and model-visible action completeness; replace unconditional report reads with inline-or-page instructions.
- [x] Implement exact-report registrations, saved-revision validation, and character-cursor pages for the action and audit sections.
- [x] Wire final corrected reports and source dependencies into both entry points, then register `pr_review_result` with live permission checks and session cleanup.
- [x] Update tool descriptions, guidelines, prompt text, README, and registration-sensitive test harnesses.
- [x] Add regression scenarios and run checks. Interactive Pi smoke testing is deferred at the user's request; no model-backed review, release installation, or global configuration change is included.

## Verification

- Handoff tests: complete small selected-fix payload; approval notes and edited findings returned verbatim after redaction; questions about unselected findings and advisory IDs include full discussion context without granting fixes; LGTM, dismissal, viewer failure, and no-changes retain no-fix semantics; non-primary requested group member retains its ID without granting other members; advisories remain unverified discussion.
- Budget tests: huge diagnostics cannot displace required feedback; huge feedback, discussion, ID lists, and individual findings become explicitly incomplete and recoverable; multibyte strings and escaped JSON stay within both result limits; optional summary truncation never claims the action is incomplete when it was fully supplied.
- Paging tests: concatenated pages reproduce exact redacted section JSON; verify offsets, null termination, Unicode boundaries, invalid offsets, and repeatable pages. Reject arbitrary or unknown identities, changed saved revisions, wrong repository identity, missing retained reports, and expired registrations.
- Entry-point tests: equivalent model-facing action data for command and tool; report details remain useful; preserve usage accounting and discussion-triggered command turns; final source drift revokes persisted and retrieved IDs; failed persistence, cancellation, or session retirement exposes no report.
- Permission tests: capture dependencies before the original operation closes; every retrieval checks live source policy with the real parent call ID; revision changes restart authorization; denial, cancellation, or service failure discloses no body and closes resources. Test registry cleanup on shutdown, replacement, `/reload`, and `/tree` using the actual Pi lifecycle hooks.
- Run `bun run --cwd pr-review check` and `bun run test:integration` during implementation, not planning.
- **Deferred by user:** manual Pi TUI check in a configured repository after loading the implementation: selected fixes, approval-with-notes, and no-fix results work without report `read` or Python extraction; an intentionally oversized handoff uses `pr_review_result` to completion. Confirm the agent inspects current project files and applies only authorized findings under normal permissions. No model-backed review or browser smoke test runs automatically.
