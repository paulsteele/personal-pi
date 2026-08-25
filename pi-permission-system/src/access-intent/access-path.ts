import {
  canonicalNormalizePathForComparison,
  getPathPolicyValues,
  normalizePathForComparison,
} from "./path-normalization";

/** Lexical and canonical POSIX representations of an accessed path. */
export class AccessPath {
  private constructor(
    private readonly lexical: string,
    private readonly aliases: readonly string[],
    private readonly canonical: string,
  ) {}

  matchValues(): string[] {
    return this.canonical ? [...new Set([...this.aliases, this.canonical])] : [...this.aliases];
  }

  boundaryValue(): string {
    return this.canonical;
  }

  value(): string {
    return this.lexical;
  }

  resolvedAlias(): string | undefined {
    return this.canonical && this.canonical !== this.lexical ? this.canonical : undefined;
  }

  static forPath(pathValue: string, options: { cwd: string; resolveBase?: string }): AccessPath {
    const resolveBase = options.resolveBase ?? options.cwd;
    return new AccessPath(
      normalizePathForComparison(pathValue, resolveBase),
      getPathPolicyValues(pathValue, { cwd: options.cwd, resolveBase }),
      canonicalNormalizePathForComparison(pathValue, resolveBase),
    );
  }

  static forLiteral(literal: string): AccessPath {
    return literal ? new AccessPath(literal, [literal], "") : new AccessPath("", [], "");
  }
}
