import { posix } from "node:path";
import { expandHomePath } from "../expand-home.ts";
import { canonicalizePath } from "../path/canonicalize-path.ts";

export function normalizePathPolicyLiteral(pathValue: string): string {
  const trimmed = pathValue.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return "";
  return expandHomePath(trimmed.startsWith("@") ? trimmed.slice(1) : trimmed);
}

export function normalizePathForComparison(pathValue: string, base: string): string {
  const literal = normalizePathPolicyLiteral(pathValue);
  return literal ? posix.normalize(posix.resolve(base, literal)) : "";
}

export function getPathPolicyValues(
  pathValue: string,
  options: { cwd?: string; resolveBase?: string },
): string[] {
  const literal = normalizePathPolicyLiteral(pathValue);
  if (!literal) return [];
  if (literal === "*") return ["*"];
  const base = options.resolveBase ?? options.cwd;
  if (!base) return [literal];
  const absolute = normalizePathForComparison(pathValue, base);
  const values = [absolute];
  if (options.cwd) {
    const cwd = normalizePathForComparison(options.cwd, options.cwd);
    const relative = posix.relative(cwd, absolute);
    if (
      relative &&
      relative !== ".." &&
      !relative.startsWith("../") &&
      !posix.isAbsolute(relative)
    ) {
      values.push(relative);
    }
  }
  values.push(literal);
  return [...new Set(values)];
}

export function canonicalNormalizePathForComparison(pathValue: string, base: string): string {
  const lexical = normalizePathForComparison(pathValue, base);
  return lexical ? canonicalizePath(lexical) : "";
}
