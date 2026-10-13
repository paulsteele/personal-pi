import { appendFileSync, closeSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensurePrivateDirectory } from "./storage.ts";

export type StartupLogEvent = "start" | "stage" | "output" | "diagnostic" | "success" | "failure";

export class SandboxStartupLog {
  private failed = false;

  private constructor(
    readonly path: string,
    private readonly descriptor: number,
    private readonly warning: (message: string) => void,
  ) {}

  static async create(
    directory: string,
    warning: (message: string) => void,
  ): Promise<SandboxStartupLog | undefined> {
    try {
      await ensurePrivateDirectory(directory);
      const filename = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.jsonl`;
      const path = join(directory, filename);
      return new SandboxStartupLog(path, openSync(path, "wx", 0o600), warning);
    } catch (error) {
      warning(`Sandbox diagnostic log unavailable: ${String(error)}`);
      return undefined;
    }
  }

  record(event: StartupLogEvent, text: string): void {
    if (this.failed) {
      return;
    }
    try {
      appendFileSync(
        this.descriptor,
        `${JSON.stringify({ timestamp: new Date().toISOString(), event, text })}\n`,
        "utf8",
      );
    } catch (error) {
      this.failed = true;
      this.warning(`Sandbox diagnostic log write failed: ${String(error)}`);
    }
  }

  close(): void {
    try {
      closeSync(this.descriptor);
    } catch (error) {
      this.warning(`Sandbox diagnostic log close failed: ${String(error)}`);
    }
  }
}
