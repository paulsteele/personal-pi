import { appendFileSync, closeSync, openSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensurePrivateDirectory } from "./storage.ts";

export const STARTUP_LOGS_RETAINED_PER_SESSION = 25;

async function removeLogIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    return;
  }
}

async function removeOldestStartupLogs(directory: string, retainedCount: number): Promise<void> {
  const logNames = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();
  const expiredNames = logNames.slice(0, Math.max(0, logNames.length - retainedCount));
  await Promise.all(expiredNames.map((name) => removeLogIfPresent(join(directory, name))));
}

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
      await removeOldestStartupLogs(directory, STARTUP_LOGS_RETAINED_PER_SESSION - 1);
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
