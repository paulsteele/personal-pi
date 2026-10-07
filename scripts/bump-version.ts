import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface ReleaseVersion {
  major: number;
  minor: number;
  patch: number;
}

interface PackageManifest {
  name: string;
  version: string;
  workspaces?: string[];
}

export interface VersionBump {
  root: string;
  currentVersion: string;
  nextVersion: string;
  changes: { path: string; before: string; after: string }[];
}

function parseReleaseVersion(version: string): ReleaseVersion {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a stable X.Y.Z version, received ${version}.`);
  }
  const [major, minor, patch] = version.split(".").map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`Version components exceed safe integers: ${version}.`);
  }
  return { major: major!, minor: minor!, patch: patch! };
}

export function nextReleaseVersion(currentVersion: string, target: string): string {
  const current = parseReleaseVersion(currentVersion);
  let nextVersion: string;
  switch (target) {
    case "major":
      nextVersion = `${current.major + 1}.0.0`;
      break;
    case "minor":
      nextVersion = `${current.major}.${current.minor + 1}.0`;
      break;
    case "patch":
      nextVersion = `${current.major}.${current.minor}.${current.patch + 1}`;
      break;
    default:
      nextVersion = target.replace(/^v/, "");
  }
  const next = parseReleaseVersion(nextVersion);
  const advancesVersion = next.major > current.major
    || (next.major === current.major && next.minor > current.minor)
    || (next.major === current.major && next.minor === current.minor && next.patch > current.patch);
  if (!advancesVersion) {
    throw new Error(`New version ${nextVersion} must be greater than ${currentVersion}.`);
  }
  return nextVersion;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceExactlyOnce(source: string, pattern: RegExp, replacement: string, label: string): string {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}; found ${matches.length}.`);
  }
  return source.replace(pattern, replacement);
}

function bumpLockfile(
  source: string,
  manifests: Map<string, PackageManifest>,
  currentVersion: string,
  nextVersion: string,
): string {
  const lock = Bun.JSONC.parse(source) as { workspaces: Record<string, PackageManifest> };
  let updated = source;
  for (const [workspace, manifest] of manifests) {
    const entry = lock.workspaces[workspace];
    if (!entry || entry.name !== manifest.name || (workspace !== "" && entry.version !== currentVersion)) {
      throw new Error(`bun.lock metadata does not match ${workspace || "root"}/package.json.`);
    }
    if (entry.version === undefined) {
      continue;
    }
    if (entry.version !== currentVersion) {
      throw new Error(`bun.lock root version does not match ${currentVersion}.`);
    }
    const workspaceVersion = new RegExp(
      `("${escapeRegExp(workspace)}"\\s*:\\s*\\{[^{}]*?"version"\\s*:\\s*")${escapeRegExp(currentVersion)}(")`,
      "g",
    );
    updated = replaceExactlyOnce(updated, workspaceVersion, `$1${nextVersion}$2`, `bun.lock version for ${workspace || "root"}`);
  }
  return updated;
}

function releaseChangelog(source: string, nextVersion: string, date: string, path: string): string {
  const headings = [...source.matchAll(/^## (?:Unreleased|\[Unreleased\])[ \t]*\r?$/gm)];
  if (headings.length === 0) {
    return source;
  }
  if (headings.length > 1) {
    throw new Error(`Multiple Unreleased sections in ${path}.`);
  }
  const heading = headings[0]!;
  const notesStart = heading.index! + heading[0].length;
  const remaining = source.slice(notesStart);
  const nextHeading = remaining.search(/^## /m);
  const notes = nextHeading === -1 ? remaining : remaining.slice(0, nextHeading);
  if (!notes.trim()) {
    return source;
  }
  const lineEnding = heading[0].endsWith("\r") ? "\r" : "";
  return source.slice(0, heading.index) + `## ${nextVersion} — ${date}${lineEnding}` + remaining;
}

export function planVersionBump(root: string, target: string, now = new Date()): VersionBump {
  root = resolve(root);
  const rootSource = readFileSync(resolve(root, "package.json"), "utf8");
  const rootManifest = JSON.parse(rootSource) as PackageManifest;
  const currentVersion = rootManifest.version;
  const nextVersion = nextReleaseVersion(currentVersion, target);
  if (!Array.isArray(rootManifest.workspaces) || !rootManifest.workspaces.every((workspace) => typeof workspace === "string")) {
    throw new Error("Expected an explicit workspace list in package.json.");
  }
  const changes: VersionBump["changes"] = [];
  const manifests = new Map<string, PackageManifest>();
  for (const workspace of ["", ...rootManifest.workspaces]) {
    const path = workspace ? `${workspace}/package.json` : "package.json";
    const before = workspace ? readFileSync(resolve(root, path), "utf8") : rootSource;
    const manifest = JSON.parse(before) as PackageManifest;
    if (manifest.version !== currentVersion) {
      throw new Error(`${path} version ${manifest.version} does not match root version ${currentVersion}.`);
    }
    manifests.set(workspace, manifest);
    const after = replaceExactlyOnce(
      before,
      new RegExp(`(^[ \\t]*"version"\\s*:\\s*")${escapeRegExp(currentVersion)}(")`, "gm"),
      `$1${nextVersion}$2`,
      `version in ${path}`,
    );
    changes.push({ path, before, after });
  }

  const lockSource = readFileSync(resolve(root, "bun.lock"), "utf8");
  changes.push({ path: "bun.lock", before: lockSource, after: bumpLockfile(lockSource, manifests, currentVersion, nextVersion) });
  const readmeSource = readFileSync(resolve(root, "README.md"), "utf8");
  const installSource = "https://github.com/paulsteele/personal-pi@v";
  const readmeAfter = replaceExactlyOnce(
    readmeSource,
    new RegExp(`${escapeRegExp(installSource)}${escapeRegExp(currentVersion)}(?![\\w.+-])`, "g"),
    `${installSource}${nextVersion}`,
    "current README install pin",
  );
  changes.push({ path: "README.md", before: readmeSource, after: readmeAfter });

  const date = now.toISOString().slice(0, 10);
  for (const workspace of rootManifest.workspaces) {
    const path = `${workspace}/CHANGELOG.md`;
    if (!existsSync(resolve(root, path))) {
      continue;
    }
    const before = readFileSync(resolve(root, path), "utf8");
    const after = releaseChangelog(before, nextVersion, date, path);
    if (after !== before) {
      changes.push({ path, before, after });
    }
  }
  return { root, currentVersion, nextVersion, changes };
}

export function applyVersionBump(plan: VersionBump): void {
  for (const change of plan.changes) {
    if (readFileSync(resolve(plan.root, change.path), "utf8") !== change.before) {
      throw new Error(`${change.path} changed after planning; rerun the bump.`);
    }
  }
  for (const change of plan.changes) {
    writeFileSync(resolve(plan.root, change.path), change.after);
  }
}

const usage = `Usage: bun run bump <patch|minor|major|X.Y.Z> [--dry-run]

Synchronize repository/workspace versions, Bun lock metadata, and the README pin.
Promote nonempty Unreleased changelog sections using today's UTC date.
No checks, commits, tags, pushes, dotfiles edits, or Pi updates are performed.`;

export function runVersionBump(root: string, args: string[]): void {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage);
    return;
  }
  const targets = args.filter((arg) => arg !== "--dry-run");
  if (targets.length !== 1 || targets[0]!.startsWith("-") || args.filter((arg) => arg === "--dry-run").length > 1) {
    throw new Error(usage);
  }
  const plan = planVersionBump(root, targets[0]!);
  const dryRun = args.includes("--dry-run");
  if (!dryRun) {
    applyVersionBump(plan);
  }
  console.log(`${dryRun ? "Would bump" : "Bumped"} ${plan.currentVersion} → ${plan.nextVersion}`);
  for (const change of plan.changes) {
    console.log(`  ${change.path}`);
  }
  console.log(`\n${dryRun ? "No files changed. After applying, review" : "Review"} the diff, complete changelog notes, and run bun install --frozen-lockfile && bun run check.`);
  console.log(`Then commit, create annotated tag v${plan.nextVersion}, push main and the tag, and update your dotfiles/Pi pin.`);
}

if (import.meta.main) {
  try {
    runVersionBump(resolve(import.meta.dir, ".."), process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
