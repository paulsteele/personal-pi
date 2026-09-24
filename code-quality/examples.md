# Calibrated preferences

## Prefer names to API-discovery narration

Remove `// TUnit.Mocks 1.49 exposes ReturnsRaw rather than ReturnsAsync for generic Task-returning methods.` Keep the actual setup unless a meaningful scenario helper improves it. Do not invent `ConfigureTaskReturnUsingReturnsRaw`.

## Name the result without an unnecessary helper

```ts
const retryDelayMs = Math.min(30_000, 1_000 * 2 ** attempt);
scheduleRetry(attempt, retryDelayMs);
```

## Name alternatives, keep mechanics visible

```ts
const isOwner = user.id === document.ownerId;
const isAdmin = user.roles.includes('admin');
const isInvitedEditor = document.editors.includes(user.id);
const canEditDocument = isOwner || isAdmin || isInvitedEditor;
```

Extract `isOverdue(invoice, now)` while leaving a filter/map pipeline visible. Keep two already-clear database/notification calls visible rather than wrapping them just to create a helper. Keep parameter-heavy pricing arithmetic local with named intermediate values.

## Tests

Prefer `makeExpiredInvitation(now)` and `inventoryWithStock(0)` for setup. Use descriptive locals rather than Arrange/Act/Assert comments. Keep explicit assertions, including named `initialChargeOptions` and `retriedChargeOptions`; do not hide expectations in an assertion helper or build an elaborate fake for a simple relationship assertion.

## Name guarantees

Prefer `keySharedAcrossChargeAttempts`, `accountIdsInGlobalLockOrder`, `startInclusive`, `endExclusive`, `delaySeconds`, and `delayMs`. A policy constant such as `DEDUPLICATION_RETENTION_MS` need not carry its provider backstory. A regex can live in `isOrderReference`; do not split familiar syntax into many trivial variables. Use `removeFileIfPresent` to name expected absence.

## Meaningful extraction

A cohesive recipient-collection operation can become `findDeliveryRecipients`. Nearby cleanup can extract `ensureEmailIsUnregistered` and `sendInvitation`. Separate source-specific entry points or a discriminated union are both reasonable; normalize before common behavior rather than creating pointless wrappers.

## Legitimate exceptions

A verified workaround comment explaining the concrete failure and removal condition may stay. Preserve explanatory docs, change history, schema-required configuration keys, license headers, lint directives, and examples of deliberately bad code. Evaluate how clearly such content communicates intent; do not turn it into a correctness, performance, or test-coverage review.

## Readability scope in practice

- Keep unused-import cleanup and hypothetical unused-variable lint warnings out of findings. An intentional `_sessionId` omission is not inherently unclear.
- An event bus carrying several event shapes may use `unknown` and a channel-specific assertion. Do not demand a narrower type or runtime validation merely as a safety improvement; assess whether the code communicates what it is doing.
- Partial object assertions can clearly state the scenario's expectations. Do not require exhaustive fields, a different matcher, or an old UI counter just because the diff changes an assertion.
- A long but clearly named object literal does not need a review finding about line breaks. The formatter owns mechanical layout.
- Do not suggest removing generation guards, adding cleanup, or changing operation ordering to fix a suspected lifecycle bug. A `structure` finding must identify a readability problem instead.
- Comparing raw and normalized values may be a functional bug; it is outside this review if the code already reads clearly. In contrast, a nested decision expression that obscures named alternatives is a readability finding even if it works correctly.
- Read all supplied hunks from a file together before deciding whether a name or helper adds meaning. An import in one hunk may be used in another; missing excerpt context cannot justify a finding.
