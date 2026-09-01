# Changelog

## Unreleased

## 1.0.4 — 2026-09-01

- Report progress as terse affirmative fragments about the work with the subject dropped, and bar meta-commentary about the session record, hedging vocabulary, and statements about what has not happened.
- Route verification owed for code that was written but not exercised into the next action, so unverified work surfaces as `Compile and run the new UI tests` rather than as a negation in the current action.
- Describe every `submit_progress` field with a worked example so structured output carries the intended shape.
- Make the next action optional and omit it entirely when nothing in the work points at one, rather than requiring a field that a model can only fill by guessing.
- Remove observer-facing framing vocabulary from the request prompt and section headings, which the model previously mirrored back into published summaries.

## 1.0.3 — 2026-09-01

- Initial release: passive side-model progress summaries published to Pi Atelier over bounded replayable events, with strict global configuration, turn-and-age scheduling, single-flight coalescing, and best-effort redaction of credential-like input.
