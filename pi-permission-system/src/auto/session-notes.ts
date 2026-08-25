import { createHash } from "node:crypto";

export const CLASSIFIER_NOTE_ENTRY = "pi-permission-system:classifier-note:v1";
export const MAX_NOTE_CHARS = 500;
export const MAX_NOTES = 8;
export const MAX_NOTE_CONTEXT_CHARS = 2_000;

export interface ClassifierNote {
  readonly text: string;
  readonly digest: string;
}

export function normalizeNote(value: unknown): ClassifierNote | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  const bounded = Array.from(text).slice(0, MAX_NOTE_CHARS).join("");
  return { text: bounded, digest: createHash("sha256").update(bounded).digest("hex") };
}

export function notesFromBranch(entries: readonly unknown[]): readonly ClassifierNote[] {
  const notes: ClassifierNote[] = [];
  for (const entry of entries) {
    const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (record.type !== "custom" || record.customType !== CLASSIFIER_NOTE_ENTRY) continue;
    const data = record.data as { version?: unknown; text?: unknown } | undefined;
    if (data?.version !== 1) continue;
    const note = normalizeNote(data.text);
    if (note) notes.push(note);
  }
  return boundedNotes(notes);
}

export function boundedNotes(notes: readonly ClassifierNote[]): readonly ClassifierNote[] {
  const newest = notes.slice(-MAX_NOTES);
  const kept: ClassifierNote[] = [];
  let size = 0;
  for (const note of [...newest].reverse()) {
    if (size + note.text.length > MAX_NOTE_CONTEXT_CHARS) continue;
    kept.unshift(note);
    size += note.text.length;
  }
  return kept;
}

export function noteDigest(notes: readonly ClassifierNote[]): string {
  return createHash("sha256")
    .update(notes.map((note) => note.digest).join("\n"))
    .digest("hex");
}
