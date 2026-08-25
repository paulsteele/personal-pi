import { lstatSync } from "node:fs";
import { posix } from "node:path";
import { AccessPath } from "./access-intent/access-path.ts";
import {
  canonicalNormalizePathForComparison,
  normalizePathForComparison,
} from "./access-intent/path-normalization.ts";
import { isPathOutsideWorkingDirectory } from "./path/path-containment.ts";
import { isPiInfrastructureRead } from "./path/pi-infrastructure-read.ts";

export type BashCdTarget =
  | { readonly kind: "absolute"; readonly value: string }
  | { readonly kind: "relative" }
  | { readonly kind: "unknown" };

/** POSIX-only path interpretation for the macOS/Linux personal fork. */
export class PathNormalizer {
  private readonly canonicalCwd: string;

  constructor(private readonly cwd: string) {
    this.canonicalCwd = canonicalNormalizePathForComparison(cwd, cwd);
  }

  forPath(pathValue: string, options?: { resolveBase?: string }): AccessPath {
    return AccessPath.forPath(pathValue, {
      cwd: this.cwd,
      ...(options?.resolveBase ? { resolveBase: options.resolveBase } : {}),
    });
  }

  forLiteral(literal: string): AccessPath {
    return AccessPath.forLiteral(literal);
  }

  forBashToken(token: string, options?: { resolveBase?: string }): AccessPath {
    return this.forPath(token, options);
  }

  isAbsolute(pathValue: string): boolean {
    return posix.isAbsolute(pathValue);
  }

  interpretBashCdTarget(target: string): BashCdTarget {
    return posix.isAbsolute(target) ? { kind: "absolute", value: target } : { kind: "relative" };
  }

  resolveBase(offset: string): string {
    return posix.resolve(this.cwd, offset);
  }

  joinBase(offset: string, target: string): string {
    return posix.join(offset, target);
  }

  isWithinDirectory(pathValue: string, directory: string): boolean {
    if (!pathValue || !directory) return false;
    if (pathValue === directory) return true;
    const relative = posix.relative(directory, pathValue);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith("../") &&
      !posix.isAbsolute(relative)
    );
  }

  isOutsideWorkingDirectory(pathValue: string): boolean {
    return isPathOutsideWorkingDirectory(
      canonicalNormalizePathForComparison(pathValue, this.cwd),
      this.canonicalCwd,
    );
  }

  isBoundaryOutsideWorkingDirectory(canonicalPath: string): boolean {
    return isPathOutsideWorkingDirectory(canonicalPath, this.canonicalCwd);
  }

  comparableValue(pathValue: string): string {
    return normalizePathForComparison(pathValue, this.cwd);
  }

  isInfrastructureRead(
    toolName: string,
    accessPath: AccessPath,
    roots: readonly string[],
  ): boolean {
    return isPiInfrastructureRead(toolName, accessPath.boundaryValue(), roots, this.cwd);
  }

  entryExists(absolutePath: string): boolean {
    try {
      lstatSync(absolutePath);
      return true;
    } catch {
      return false;
    }
  }
}
