import type { TSNode } from "./parser.ts";
import { plainExpansionName, resolvePlainVariableExpansion } from "./shell-variable-expansion.ts";

/**
 * Node types whose text content is never a command argument, so no path
 * candidate is ever read from it.
 *
 * This governs the subtree's *text*, not whether it is visited at all: an
 * interpolating `heredoc_body` is also an execution host, so it is still
 * descended for the commands it runs while its prose stays out of the path
 * surface (#741). See `EXECUTION_HOST_TYPES` in `nested-execution.ts`.
 */
export const SKIP_SUBTREE_TYPES = new Set(["heredoc_body", "heredoc_end", "comment"]);

/**
 * Node types that represent argument values in the AST
 * (word, concatenation, single-quoted string, double-quoted string).
 */
export const ARG_NODE_TYPES = new Set(["word", "concatenation", "string", "raw_string"]);

/**
 * Resolve the "shell value" of an argument node — the string the shell
 * would pass to the command after quote removal.
 *
 * - `word`          → `.text` (already unquoted)
 * - `raw_string`    → strip surrounding single quotes
 * - `string`        → strip surrounding double quotes, concatenate children text
 * - `concatenation` → concatenate resolved children
 * - expansions      → the resolved value of a plain `$HOME`/`$PWD` reference,
 *   else `.text` (see `shell-variable-expansion.ts`)
 * - other           → `.text` as fallback
 */
export function resolveNodeText(
  node: TSNode,
  resolveLocal?: (name: string) => readonly string[] | null | undefined,
): string {
  switch (node.type) {
    case "word":
      return node.text;
    case "raw_string": {
      // Strip surrounding single quotes: 'content' → content
      const t = node.text;
      if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
        return t.slice(1, -1);
      }
      return t;
    }
    case "string": {
      // Double-quoted string: concatenate the resolved text of inner children,
      // skipping the quote-delimiter nodes (literal `"`).
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        // Skip the literal `"` delimiters
        if (child.type === '"') continue;
        result += resolveNodeText(child, resolveLocal);
      }
      return result;
    }
    case "string_content":
      return node.text;
    case "simple_expansion":
    case "expansion":
      return resolvePlainVariableExpansion(node, resolveLocal) ?? node.text;
    case "concatenation": {
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        result += resolveNodeText(child, resolveLocal);
      }
      return result;
    }
    default:
      return node.text;
  }
}

/**
 * Resolve all bounded values of an argument node under local shell bindings.
 * Returns `null` when an expansion is not statically known or the cartesian
 * product would exceed `limit`.
 */
export function resolveNodeTextAlternatives(
  node: TSNode,
  resolveLocal: (name: string) => readonly string[] | null | undefined,
  limit = 16,
): string[] | null {
  if (node.type === "simple_expansion" || node.type === "expansion") {
    const name = plainExpansionName(node);
    if (name === null) return null;
    const local = resolveLocal(name);
    if (local !== undefined) return bounded(local, limit);
    const ambient = resolvePlainVariableExpansion(node);
    return ambient === null ? null : [ambient];
  }
  if (node.type === "raw_string") {
    const text = node.text;
    return [
      text.length >= 2 && text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1) : text,
    ];
  }
  if (node.type === "word" || node.type === "string_content") return [node.text];
  if (node.type !== "string" && node.type !== "concatenation") {
    return [resolveNodeText(node)];
  }

  let values = [""];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.type === '"') continue;
    const parts = resolveNodeTextAlternatives(child, resolveLocal, limit);
    if (parts === null || values.length * parts.length > limit) return null;
    values = values.flatMap((prefix) => parts.map((part) => prefix + part));
  }
  return values;
}

function bounded(values: readonly string[] | null | undefined, limit: number): string[] | null {
  if (values == null || values.length === 0 || values.length > limit) return null;
  return [...new Set(values)].slice(0, limit);
}
