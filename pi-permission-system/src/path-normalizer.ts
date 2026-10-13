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
  private readonly resolvedGuestEntryExistenceByPath = new Map<string, boolean>();
  private readonly pendingGuestEntryPaths = new Set<string>();

  constructor(
    private readonly cwd: string,
    private readonly mode: "host" | "guest" = "host",
    readonly guestHome?: string,
  ) {
    this.canonicalCwd =
      mode === "guest" ? posix.normalize(cwd) : canonicalNormalizePathForComparison(cwd, cwd);
  }

  forPath(pathValue: string, options?: { resolveBase?: string }): AccessPath {
    if (this.mode === "guest") {
      const guestHomeExpandedPath = this.guestHome
        ? pathValue.replace(/^~(?=\/|$)/, this.guestHome)
        : pathValue;
      return AccessPath.forGuestPath(guestHomeExpandedPath, { cwd: this.cwd, ...options });
    }
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
    if (this.mode === "guest") {
      return isPathOutsideWorkingDirectory(posix.resolve(this.cwd, pathValue), this.canonicalCwd);
    }
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

  async prepareGuestEntryProbes(
    probe?: (paths: readonly string[]) => Promise<readonly boolean[]>,
  ): Promise<boolean> {
    if (this.mode !== "guest" || this.pendingGuestEntryPaths.size === 0) {
      return false;
    }
    if (!probe) {
      throw new Error("Guest bare-path resolution requires a guest existence probe");
    }
    const paths = [...this.pendingGuestEntryPaths];
    const maxPathsPerProbeBatch = 128;
    for (
      let batchStartIndex = 0;
      batchStartIndex < paths.length;
      batchStartIndex += maxPathsPerProbeBatch
    ) {
      const batch = paths.slice(batchStartIndex, batchStartIndex + maxPathsPerProbeBatch);
      const existence = await probe(batch);
      if (
        existence.length !== batch.length ||
        existence.some((value) => typeof value !== "boolean")
      ) {
        throw new Error("Guest existence probe returned incomplete results");
      }
      for (const [index, path] of batch.entries()) {
        this.resolvedGuestEntryExistenceByPath.set(path, existence[index]!);
      }
    }
    this.pendingGuestEntryPaths.clear();
    return true;
  }

  entryExists(absolutePath: string): boolean {
    if (this.mode === "guest") {
      const path = posix.normalize(absolutePath);
      const exists = this.resolvedGuestEntryExistenceByPath.get(path);
      if (exists === undefined) {
        this.pendingGuestEntryPaths.add(path);
      }
      return exists === true;
    }
    try {
      lstatSync(absolutePath);
      return true;
    } catch {
      return false;
    }
  }
}
