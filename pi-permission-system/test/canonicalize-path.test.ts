import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizePath } from "#src/path/canonicalize-path.ts";

describe("canonical paths with missing destinations", () => {
  it("resolves relative dangling links and chained missing tails", () => {
    const root = mkdtempSync(join(tmpdir(), "permission-dangling-"));
    try {
      mkdirSync(join(root, "nested"));
      symlinkSync("nested/alias", join(root, ".env.example"));
      symlinkSync("../.env", join(root, "nested/alias"));
      expect(canonicalizePath(join(root, ".env.example"))).toBe(join(realpathSync(root), ".env"));
      symlinkSync(join(root, "missing"), join(root, "directory"));
      expect(canonicalizePath(join(root, "directory", "child"))).toBe(
        join(realpathSync(root), "missing", "child"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("bounds cycles instead of following links indefinitely", () => {
    const root = mkdtempSync(join(tmpdir(), "permission-link-cycle-"));
    try {
      symlinkSync("b", join(root, "a"));
      symlinkSync("a", join(root, "b"));
      expect(canonicalizePath(join(root, "a"))).toBe(join(root, "a"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
