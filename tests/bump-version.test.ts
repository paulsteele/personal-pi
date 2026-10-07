import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { applyVersionBump, nextReleaseVersion, planVersionBump, runVersionBump } from "../scripts/bump-version.ts";

interface RejectedBumpScenario {
  scenario: string;
  overrides: Record<string, string>;
  message: string;
}

interface FixtureLockfile {
  workspaces: Record<string, { version?: string; devDependencies?: Record<string, string> }>;
  packages: Record<string, unknown>;
}

const fixtures: string[] = [];

function releaseFixture(overrides: Record<string, string> = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), "pi-version-bump-"));
  fixtures.push(root);
  const files = {
    "package.json": '{\n  "name": "extensions",\n  "version": "1.5.6",\n  "workspaces": ["first", "second", "without-notes"],\n  "devDependencies": { "same-version-dependency": "1.5.6" }\n}\n',
    "first/package.json": '{\n\t"name": "@example/first",\n\t"version": "1.5.6",\n\t"description": "Release 1.5.6 remains historical"\n}\n',
    "second/package.json": '{\n  "name": "@example/second",\n  "version": "1.5.6"\n}\n',
    "without-notes/package.json": '{\n  "name": "@example/without-notes",\n  "version": "1.5.6"\n}\n',
    "bun.lock": `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "extensions", "devDependencies": { "same-version-dependency": "1.5.6" } },
    "first": { "name": "@example/first", "version": "1.5.6", },
    "second": { "name": "@example/second", "version": "1.5.6", },
    "without-notes": { "name": "@example/without-notes", "version": "1.5.6", },
  },
  "packages": {
    "same-version-dependency": ["same-version-dependency@1.5.6", "", {}, "integrity"],
  },
}
`,
    "README.md": "# Extensions\n\npi install https://github.com/paulsteele/personal-pi@v1.5.6\n\nHistorical example: version 1.5.6.\n",
    "first/CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n- Add a feature.\n\n## 1.5.6 — 2026-10-02\n\n- Previous release.\n",
    "second/CHANGELOG.md": "# Changelog\n\n## 1.5.5\n\n- Previous change.\n",
    ...overrides,
  };
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = resolve(root, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  return root;
}

function fixtureContents(root: string): Record<string, string> {
  const paths = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name));
  return Object.fromEntries(paths.map((path) => [path, readFileSync(path, "utf8")]));
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("release version selection", () => {
  test.each([
    ["patch", "1.5.7"],
    ["minor", "1.6.0"],
    ["major", "2.0.0"],
    ["1.9.3", "1.9.3"],
    ["v2.0.0", "2.0.0"],
  ])("advances 1.5.6 with %s to %s", (target, expected) => {
    expect(nextReleaseVersion("1.5.6", target)).toBe(expected);
  });

  test.each(["1.5.6", "1.5.5", "0.9.0", "1.05.7", "1.6", "1.6.0-beta.1", "1.6.0+build", "banana", "9007199254740992.0.0"])(
    "rejects non-advancing or invalid target %s",
    (target) => {
      expect(() => nextReleaseVersion("1.5.6", target)).toThrow();
    },
  );
});

describe("version bump preparation", () => {
  test("discovers every workspace and updates only release metadata and pending notes", () => {
    const root = releaseFixture();
    const before = fixtureContents(root);
    const plan = planVersionBump(root, "patch", new Date("2026-10-07T23:30:00Z"));
    expect(fixtureContents(root)).toEqual(before);
    expect(plan.currentVersion).toBe("1.5.6");
    expect(plan.nextVersion).toBe("1.5.7");
    expect(plan.changes.map((change) => change.path)).toEqual([
      "package.json", "first/package.json", "second/package.json", "without-notes/package.json",
      "bun.lock", "README.md", "first/CHANGELOG.md",
    ]);

    applyVersionBump(plan);
    for (const workspace of ["", "first", "second", "without-notes"]) {
      const path = resolve(root, workspace, "package.json");
      expect(JSON.parse(readFileSync(path, "utf8")).version).toBe("1.5.7");
      expect(readFileSync(path, "utf8")).toBe(before[path]!.replace('"version": "1.5.6"', '"version": "1.5.7"'));
    }
    const lockSource = readFileSync(resolve(root, "bun.lock"), "utf8");
    const lock = Bun.JSONC.parse(lockSource) as FixtureLockfile;
    const previousLock = Bun.JSONC.parse(before[resolve(root, "bun.lock")]!) as FixtureLockfile;
    expect(lock.workspaces["first"].version).toBe("1.5.7");
    expect(lock.workspaces["second"].version).toBe("1.5.7");
    expect(lock.workspaces["without-notes"].version).toBe("1.5.7");
    expect(lock.workspaces[""].version).toBeUndefined();
    expect(lock.workspaces[""].devDependencies).toEqual(previousLock.workspaces[""].devDependencies);
    expect(lock.packages).toEqual(previousLock.packages);
    expect(lockSource).toBe(before[resolve(root, "bun.lock")]!.replaceAll('"version": "1.5.6"', '"version": "1.5.7"'));
    expect(readFileSync(resolve(root, "README.md"), "utf8")).toBe(
      "# Extensions\n\npi install https://github.com/paulsteele/personal-pi@v1.5.7\n\nHistorical example: version 1.5.6.\n",
    );
    expect(readFileSync(resolve(root, "first/CHANGELOG.md"), "utf8")).toBe(
      "# Changelog\n\n## 1.5.7 — 2026-10-07\n\n- Add a feature.\n\n## 1.5.6 — 2026-10-02\n\n- Previous release.\n",
    );
    expect(readFileSync(resolve(root, "second/CHANGELOG.md"), "utf8")).toBe(before[resolve(root, "second/CHANGELOG.md")]);
  });

  test("preserves empty Unreleased sections and historical versions", () => {
    const root = releaseFixture({ "first/CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n## 1.5.6\n\n- Old note.\n" });
    const plan = planVersionBump(root, "minor");
    expect(plan.changes.some((change) => change.path.endsWith("CHANGELOG.md"))).toBe(false);
  });

  test("promotes bracketed Unreleased notes while preserving CRLF", () => {
    const root = releaseFixture({ "first/CHANGELOG.md": "# Changelog\r\n\r\n## [Unreleased]\r\n\r\n- Feature.\r\n" });
    const plan = planVersionBump(root, "major", new Date("2026-10-07T00:00:00Z"));
    expect(plan.changes.find((change) => change.path === "first/CHANGELOG.md")?.after).toBe(
      "# Changelog\r\n\r\n## 2.0.0 — 2026-10-07\r\n\r\n- Feature.\r\n",
    );
  });

  test.each([
    {
      scenario: "workspace mismatch",
      overrides: { "second/package.json": '{"name":"@example/second","version":"1.5.5"}' },
      message: "does not match root version",
    },
    {
      scenario: "missing lock workspace",
      overrides: { "bun.lock": '{"workspaces":{"":{"name":"extensions"}}}' },
      message: "bun.lock metadata does not match",
    },
    {
      scenario: "outdated README",
      overrides: { "README.md": "pi install https://github.com/paulsteele/personal-pi@v1.5.5\n" },
      message: "current README install pin",
    },
    {
      scenario: "ambiguous changelog",
      overrides: { "first/CHANGELOG.md": "## Unreleased\n\n- A.\n\n## Unreleased\n\n- B.\n" },
      message: "Multiple Unreleased sections",
    },
  ] as RejectedBumpScenario[])("rejects $scenario before any file changes", ({ overrides, message }) => {
    const root = releaseFixture(overrides);
    const before = fixtureContents(root);
    expect(() => planVersionBump(root, "patch")).toThrow(message);
    expect(fixtureContents(root)).toEqual(before);
  });

  test("refuses to overwrite a file edited after planning without applying earlier changes", () => {
    const root = releaseFixture();
    const plan = planVersionBump(root, "patch");
    writeFileSync(resolve(root, "README.md"), "New user edits\n");
    const beforeApply = fixtureContents(root);
    expect(() => applyVersionBump(plan)).toThrow("README.md changed after planning");
    expect(fixtureContents(root)).toEqual(beforeApply);
  });

  test("plans the real repository without touching its checkout", () => {
    const root = resolve(import.meta.dir, "..");
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const plan = planVersionBump(root, "patch");
    expect(plan.currentVersion).toBe(manifest.version);
    expect(plan.changes.filter((change) => change.path.endsWith("package.json"))).toHaveLength(9);
    expect(plan.changes.find((change) => change.path === "README.md")?.after).toContain(
      `https://github.com/paulsteele/personal-pi@v${plan.nextVersion}`,
    );
  });
});

describe("bump command", () => {
  test("dry-run reports files and next steps without writing", () => {
    const root = releaseFixture();
    const before = fixtureContents(root);
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      runVersionBump(root, ["--dry-run", "patch"]);
      expect(fixtureContents(root)).toEqual(before);
      const messages = output.mock.calls.flat().join("\n");
      expect(messages).toContain("Would bump 1.5.6 → 1.5.7");
      expect(messages).toContain("bun.lock");
      expect(messages).toContain("No files changed.");
      expect(messages).toContain("annotated tag v1.5.7");
    } finally {
      output.mockRestore();
    }
  });

  test("applies an explicit target without running release or machine commands", () => {
    const root = releaseFixture();
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      runVersionBump(root, ["v1.6.0"]);
      expect(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version).toBe("1.6.0");
      expect(output.mock.calls.flat().join("\n")).toContain("Bumped 1.5.6 → 1.6.0");
    } finally {
      output.mockRestore();
    }
  });

  test.each([[], ["--publish"], ["patch", "minor"], ["patch", "--dry-run", "--dry-run"]])(
    "rejects invalid arguments %j without writing",
    (...args: string[]) => {
      const root = releaseFixture();
      const before = fixtureContents(root);
      expect(() => runVersionBump(root, args)).toThrow("Usage:");
      expect(fixtureContents(root)).toEqual(before);
    },
  );
});
