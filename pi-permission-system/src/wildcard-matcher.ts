import { expandHomePath } from "./expand-home";

export interface CompiledWildcardPattern<TState> {
  readonly pattern: string;
  readonly state: TState;
  matches(value: string): boolean;
}

export type WildcardPatternMatch<TState> = {
  state: TState;
  matchedPattern: string;
  matchedName: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileWildcardPattern<TState>(
  pattern: string,
  state: TState,
): CompiledWildcardPattern<TState> {
  let escaped = expandHomePath(pattern)
    .split("*")
    .map((part) => escapeRegExp(part).replaceAll("\\?", "."))
    .join(".*");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  const regex = new RegExp(`^${escaped}$`, "s");
  return { pattern, state, matches: (value) => regex.test(value) };
}

export function wildcardMatch(pattern: string, value: string): boolean {
  return compileWildcardPattern(pattern, null).matches(value);
}

export function compileWildcardPatternEntries<TState>(
  entries: Iterable<readonly [string, TState]>,
): CompiledWildcardPattern<TState>[] {
  return Array.from(entries, ([pattern, state]) => compileWildcardPattern(pattern, state));
}

export function findCompiledWildcardMatch<TState>(
  patterns: readonly CompiledWildcardPattern<TState>[],
  name: string,
): WildcardPatternMatch<TState> | null {
  const match = patterns.findLast((pattern) => pattern.matches(name));
  return match ? { state: match.state, matchedPattern: match.pattern, matchedName: name } : null;
}
