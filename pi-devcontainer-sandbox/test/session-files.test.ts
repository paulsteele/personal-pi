import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sessionFileGrants } from "#src/session-files.ts";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "session-file-grants-"));
  dirs.push(dir);
  const path = join(dir, "report.json");
  writeFileSync(path, "{}");
  return { dir, path, event: { version: 1, sessionId: "current", paths: [path] } };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("canonicalizes and deduplicates exact existing files", () => {
  const { dir, path, event } = fixture();
  const alias = join(dir, "alias.json");
  symlinkSync(path, alias);
  expect(sessionFileGrants({ ...event, paths: [path, alias] }, "current")).toEqual([
    realpathSync(path),
  ]);
});

it("requires a versioned event for the active session", () => {
  const { event } = fixture();
  for (const data of [
    null,
    "report.json",
    {},
    { ...event, version: 2 },
    { ...event, sessionId: "old" },
  ])
    expect(sessionFileGrants(data, "current")).toEqual([]);
  expect(sessionFileGrants(event, "")).toEqual([]);
});

it("rejects directories, missing paths, relative paths, and malformed batches atomically", () => {
  const { dir, path, event } = fixture();
  const directoryAlias = join(dir, "directory-alias");
  symlinkSync(dir, directoryAlias);
  for (const paths of [
    [],
    [dir],
    [directoryAlias],
    ["/"],
    [join(dir, "*.json")],
    [join(dir, "missing.json")],
    ["report.json"],
    [null],
    [path, 1],
    [path, join(dir, "missing.json")],
    ["/bad\0path"],
    Array(101).fill(path),
    path,
  ])
    expect(sessionFileGrants({ ...event, paths }, "current")).toEqual([]);
});
