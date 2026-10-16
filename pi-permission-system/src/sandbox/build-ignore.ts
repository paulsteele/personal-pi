import { join, posix } from "node:path";
import { readPrivateText, sha256Hex } from "./storage.ts";

type IgnoreMatchType = "exact" | "prefix" | "suffix" | "regexp";

interface IgnorePattern {
  pattern: string;
  isException: boolean;
  matchType: IgnoreMatchType;
  regexp?: RegExp;
}

export interface BuildContextIgnore {
  revision: string;
  skipsEntry(relativePath: string, isDirectory: boolean): boolean;
}

export async function loadBuildContextIgnore(
  context: string,
  containerfile?: string,
): Promise<BuildContextIgnore> {
  const contextContainerIgnore = await readPrivateText(join(context, ".containerignore"));
  const contextDockerIgnore = await readPrivateText(join(context, ".dockerignore"));
  const containerfileContainerIgnore = containerfile
    ? await readPrivateText(`${containerfile}.containerignore`)
    : undefined;
  const containerfileDockerIgnore = containerfile
    ? await readPrivateText(`${containerfile}.dockerignore`)
    : undefined;
  const contextIgnore = contextContainerIgnore ?? contextDockerIgnore;
  const containerfileIgnore = containerfileDockerIgnore ?? containerfileContainerIgnore;
  // Local Buildah prefers the Containerfile-specific file, while podman-remote and feature-generated
  // Containerfiles use the context file. Skip a path only when every candidate excludes it.
  const candidatePatternLists = [parseIgnorePatterns(contextIgnore?.text ?? "")];
  if (containerfileIgnore) {
    candidatePatternLists.push(parseIgnorePatterns(containerfileIgnore.text));
  }
  return {
    revision: sha256Hex(
      JSON.stringify(
        [
          contextContainerIgnore,
          contextDockerIgnore,
          containerfileContainerIgnore,
          containerfileDockerIgnore,
        ].map((file) => file?.revision),
      ),
    ),
    skipsEntry: (relativePath, isDirectory) =>
      candidatePatternLists.every((patterns) => {
        if (!isExcluded(patterns, relativePath)) {
          return false;
        }
        const mayContainReincludedEntries =
          isDirectory && hasExceptionBeneath(patterns, relativePath);
        return !mayContainReincludedEntries;
      }),
  };
}

export function parseIgnorePatterns(text: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  for (const line of lines.map((rawLine) => rawLine.replace(/\r$/, ""))) {
    if (line.startsWith("#")) {
      continue;
    }
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }
    const isException = trimmedLine.startsWith("!");
    const pattern = cleanIgnorePattern(isException ? trimmedLine.slice(1).trim() : trimmedLine);
    if (!pattern) {
      throw new Error(`Invalid build ignore pattern: ${JSON.stringify(trimmedLine)}`);
    }
    patterns.push({ pattern, isException, ...compileIgnorePattern(pattern) });
  }
  return patterns;
}

export function isExcluded(patterns: IgnorePattern[], relativePath: string): boolean {
  const parentSegments = relativePath.split("/").slice(0, -1);
  let excluded = false;
  for (const pattern of patterns) {
    const canChangeOutcome = pattern.isException === excluded;
    if (!canChangeOutcome) {
      continue;
    }
    let matches = matchesIgnorePattern(pattern, relativePath);
    for (let depth = 1; !matches && depth <= parentSegments.length; depth++) {
      matches = matchesIgnorePattern(pattern, parentSegments.slice(0, depth).join("/"));
    }
    if (matches) {
      excluded = !pattern.isException;
    }
  }
  return excluded;
}

function hasExceptionBeneath(patterns: IgnorePattern[], relativeDirectory: string): boolean {
  const directoryPrefix = `${relativeDirectory}/`;
  return patterns.some((pattern) => {
    if (!pattern.isException) {
      return false;
    }
    const literalPrefix = pattern.pattern.split(/[*?[\\]/, 1)[0];
    return literalPrefix.startsWith(directoryPrefix) || directoryPrefix.startsWith(literalPrefix);
  });
}

function cleanIgnorePattern(pattern: string): string {
  if (!pattern) {
    return "";
  }
  const normalized = posix.normalize(pattern);
  const withoutTrailingSlash =
    normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  return withoutTrailingSlash.length > 1 && withoutTrailingSlash.startsWith("/")
    ? withoutTrailingSlash.slice(1)
    : withoutTrailingSlash;
}

function compileIgnorePattern(pattern: string): Pick<IgnorePattern, "matchType" | "regexp"> {
  const regexEscapedCharacters = new Set([".", "+", "(", ")", "|", "{", "}", "$"]);
  const characters = Array.from(pattern);
  let source = "^";
  let matchType: IgnoreMatchType = "exact";
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    const startsPattern = index === 0;
    if (character === "*" && characters[index + 1] === "*") {
      const isLeadingDoubleStar = startsPattern;
      const consumesFollowingSlash = characters[index + 2] === "/";
      const doubleStarEnd = index + (consumesFollowingSlash ? 3 : 2);
      const isTrailingDoubleStar = doubleStarEnd === characters.length;
      const isLiteralPrefix = isTrailingDoubleStar && matchType === "exact";

      source += isTrailingDoubleStar ? ".*" : "(.*/)?";
      if (isLeadingDoubleStar) {
        matchType = "suffix";
      } else if (isLiteralPrefix) {
        matchType = "prefix";
      } else {
        matchType = "regexp";
      }
      index = doubleStarEnd - 1;
    } else if (character === "*") {
      source += "[^/]*";
      matchType = "regexp";
    } else if (character === "?") {
      source += "[^/]";
      matchType = "regexp";
    } else if (regexEscapedCharacters.has(character)) {
      source += `\\${character}`;
    } else if (character === "\\") {
      const escapedCharacter = characters[index + 1];
      if (escapedCharacter === undefined) {
        source += "\\";
      } else {
        index++;
        source += `\\${escapedCharacter}`;
        matchType = "regexp";
      }
    } else if (character === "[" || character === "]") {
      source += character;
      matchType = "regexp";
    } else {
      source += character;
    }
  }
  if (matchType !== "regexp") {
    return { matchType };
  }
  try {
    return { matchType, regexp: new RegExp(`${source}$`) };
  } catch {
    throw new Error(`Invalid build ignore pattern: ${JSON.stringify(pattern)}`);
  }
}

function matchesIgnorePattern(pattern: IgnorePattern, path: string): boolean {
  switch (pattern.matchType) {
    case "exact": {
      return path === pattern.pattern;
    }
    case "prefix": {
      return path.startsWith(pattern.pattern.slice(0, -2));
    }
    case "suffix": {
      const suffix = pattern.pattern.slice(2);
      return path.endsWith(suffix) || (suffix.startsWith("/") && path === suffix.slice(1));
    }
    case "regexp": {
      return pattern.regexp!.test(path);
    }
  }
}
