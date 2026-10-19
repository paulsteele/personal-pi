import { appendFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { GuestFilesystemTiming } from "./guest-filesystem-transport.ts";

export const GUEST_TIMING_LOG_ROTATION_BYTES = 5 * 1024 * 1024;

export function guestTimingLogPath(sessionDirectory: string): string {
  return join(sessionDirectory, "guest-timing.jsonl");
}

/** Appends per-request guest filesystem timings; keeps one previous file once the log is full. */
export function createGuestTimingLog(
  path: string,
  rotationBytes = GUEST_TIMING_LOG_ROTATION_BYTES,
): (timing: GuestFilesystemTiming) => void {
  let writes = Promise.resolve();
  const appendTiming = async (timing: GuestFilesystemTiming) => {
    const currentBytes = (await stat(path).catch(() => undefined))?.size ?? 0;
    if (currentBytes >= rotationBytes) {
      await rename(path, `${path}.1`);
    }
    const entry = { timestamp: new Date().toISOString(), ...timing };
    await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  };
  return (timing) => {
    writes = writes.then(() => appendTiming(timing)).catch(() => {});
  };
}
