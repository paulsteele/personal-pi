import { describe, expect, it } from "vitest";
import {
  boundedNotes,
  CLASSIFIER_NOTE_ENTRY,
  normalizeNote,
  noteDigest,
  notesFromBranch,
} from "#src/auto/session-notes.ts";

describe("classifier session notes", () => {
  it("sanitizes, persists, and reconstructs active-branch notes", () => {
    const note = normalizeNote("  scope: deploy only\n\u001b[31mplease  ")!;
    expect(note.text).toBe("scope: deploy only please");
    const restored = notesFromBranch([
      { type: "custom", customType: CLASSIFIER_NOTE_ENTRY, data: { version: 1, text: note.text } },
    ]);
    expect(restored).toEqual([note]);
    expect(noteDigest(restored)).toHaveLength(64);
  });
  it("keeps the newest bounded set", () => {
    const notes = Array.from({ length: 12 }, (_, index) => normalizeNote(`n${index}`)!);
    expect(boundedNotes(notes)).toHaveLength(8);
    expect(boundedNotes(notes)[0]?.text).toBe("n4");
  });
});
