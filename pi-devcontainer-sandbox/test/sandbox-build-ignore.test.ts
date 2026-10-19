import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  isExcluded,
  loadBuildContextIgnore,
  parseIgnorePatterns,
} from "../src/sandbox/build-ignore.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function contextWithIgnoreFiles(files: Record<string, string>) {
  const context = await mkdtemp(join(tmpdir(), "sandbox-build-ignore-"));
  directories.push(context);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(context, name, ".."), { recursive: true });
    await writeFile(join(context, name), text);
  }
  return context;
}

it.each([
  ["node_modules", "node_modules", true],
  ["node_modules", "node_modules/pkg/index.js", true],
  ["/node_modules/", "node_modules/pkg", true],
  ["node_modules", "packages/app/node_modules", false],
  ["**/node_modules", "packages/app/node_modules/pkg", true],
  ["**/node_modules", "node_modules", true],
  ["*.log", "debug.log", true],
  ["*.log", "logs/debug.log", false],
  ["*/temp*", "somedir/temporary.txt", true],
  ["temp?", "tempa", true],
  ["build/**", "build/app/index.html", true],
  ["docs/**/*.md", "docs/a/b/readme.md", true],
  ["docs/**/*.md", "docs/readme.md", true],
  ["# comment", "# comment", false],
])("pattern %j excludes %j: %s", (pattern, path, expected) => {
  expect(isExcluded(parseIgnorePatterns(pattern), path)).toBe(expected);
});

it("lets the last matching line decide, including exceptions", () => {
  const patterns = parseIgnorePatterns("*.md\n!README*.md\nREADME-secret.md\n");
  expect(isExcluded(patterns, "notes.md")).toBe(true);
  expect(isExcluded(patterns, "README.md")).toBe(false);
  expect(isExcluded(patterns, "README-secret.md")).toBe(true);
});

it("keeps descending into an excluded directory that has a re-included descendant", async () => {
  const context = await contextWithIgnoreFiles({
    ".dockerignore": "node_modules\nscripts\n!scripts/install.sh\n",
  });
  const ignore = await loadBuildContextIgnore(context);
  expect(ignore.skipsEntry("node_modules", true)).toBe(true);
  expect(ignore.skipsEntry("scripts", true)).toBe(false);
  expect(ignore.skipsEntry("scripts/other.sh", false)).toBe(true);
  expect(ignore.skipsEntry("scripts/install.sh", false)).toBe(false);
});

it("prefers .containerignore over .dockerignore in the context", async () => {
  const context = await contextWithIgnoreFiles({
    ".containerignore": "build\n",
    ".dockerignore": "node_modules\n",
  });
  const ignore = await loadBuildContextIgnore(context);
  expect(ignore.skipsEntry("build", true)).toBe(true);
  expect(ignore.skipsEntry("node_modules", true)).toBe(false);
});

it("skips only entries excluded by both the context and Containerfile-specific ignore files", async () => {
  const context = await contextWithIgnoreFiles({
    ".dockerignore": "node_modules\n.git\n",
    ".devcontainer/Dockerfile.dockerignore": "node_modules\nbuild\n",
  });
  const ignore = await loadBuildContextIgnore(
    context,
    join(context, ".devcontainer", "Dockerfile"),
  );
  expect(ignore.skipsEntry("node_modules", true)).toBe(true);
  expect(ignore.skipsEntry(".git", true)).toBe(false);
  expect(ignore.skipsEntry("build", true)).toBe(false);
});

it("changes its revision when an ignore file changes", async () => {
  const context = await contextWithIgnoreFiles({ ".dockerignore": "node_modules\n" });
  const before = (await loadBuildContextIgnore(context)).revision;
  await writeFile(join(context, ".dockerignore"), "build\n");
  expect((await loadBuildContextIgnore(context)).revision).not.toBe(before);
});
