import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { GuestFilesystem } from "./filesystem.ts";

export class SandboxArtifacts {
  private readonly ownedHostPaths = new Set<string>();
  constructor(private readonly filesystem: GuestFilesystem) {}

  registerProducedPath(path: string): void {
    this.ownedHostPaths.add(path);
  }

  async transferProducedPath(path: string, signal?: AbortSignal): Promise<string> {
    if (!this.ownedHostPaths.delete(path)) {
      throw new Error("Artifact was not produced by an audited tool in this session");
    }
    const destination = `/tmp/pi-sandbox-artifacts/${randomUUID()}`;
    const content = await readFile(path);
    await this.filesystem.mkdir("/tmp/pi-sandbox-artifacts", signal);
    await this.filesystem.write(destination, content, signal);
    return destination;
  }

  clear(): void {
    this.ownedHostPaths.clear();
  }
}
