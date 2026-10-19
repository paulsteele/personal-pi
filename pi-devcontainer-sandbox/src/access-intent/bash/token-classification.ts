import { expandHomePath } from "../../expand-home.ts";

const SHELL_METACHARACTERS = /[|&;(){}<>`$]/;
const DRIVE_LETTER = /^[A-Za-z]:[\\/]/;

/** Returns a definitely path-shaped token, or null for bare/command syntax. */
export function classifyTokenAsPathCandidate(token: string): string | null {
  const value = token.trim();
  if (!value || SHELL_METACHARACTERS.test(value)) return null;
  if (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.startsWith("$HOME/") ||
    value.startsWith("${HOME}/")
  ) {
    return expandHomePath(value);
  }
  return value.includes("/") || DRIVE_LETTER.test(value) ? value : null;
}

/** Rule candidates use the same POSIX path shape in this fork. */
export function classifyTokenAsRuleCandidate(token: string): string | null {
  return classifyTokenAsPathCandidate(token);
}

/** A bare filename can be promoted only after a filesystem existence probe. */
export function classifyBareTokenCandidate(token: string): string | null {
  const value = token.trim();
  if (!value || SHELL_METACHARACTERS.test(value)) return null;
  if (value.startsWith("-") || value.includes("/") || value.includes("\\")) return null;
  return value;
}
