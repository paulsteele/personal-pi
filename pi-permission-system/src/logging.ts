import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactedJsonStringify } from "./log-redaction.ts";
import {
  OWNER_ONLY_DIRECTORY_MODE,
  OWNER_ONLY_FILE_MODE,
  restrictExistingPathToOwner,
} from "./log-file-permissions.ts";

const MAX_FIELD = 1_000;
function cap(value: unknown): unknown {
  if (typeof value === "string")
    return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…` : value;
  if (Array.isArray(value)) return value.map(cap);
  if (value && typeof value === "object" && !Array.isArray(value))
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cap(child)]));
  return value;
}

export class ReviewLogger {
  constructor(private readonly path: string) {}
  review(event: string, details: Record<string, unknown> = {}): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
      restrictExistingPathToOwner(dirname(this.path), OWNER_ONLY_DIRECTORY_MODE);
      restrictExistingPathToOwner(this.path, OWNER_ONLY_FILE_MODE);
      const bounded = cap(details) as Record<string, unknown>;
      const line = redactedJsonStringify({
        timestamp: new Date().toISOString(),
        extension: "pi-permission-system-local",
        event,
        ...bounded,
      });
      if (line) {
        appendFileSync(this.path, `${line}\n`, { encoding: "utf8", mode: OWNER_ONLY_FILE_MODE });
        restrictExistingPathToOwner(this.path, OWNER_ONLY_FILE_MODE);
      }
    } catch {
      /* logging cannot weaken enforcement */
    }
  }
}
