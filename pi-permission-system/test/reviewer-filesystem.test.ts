import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

interface FilesystemRequest {
  id: number;
  operation: string;
  paths?: string[];
  path?: string;
  content?: string;
  command?: string;
}

async function filesystemRequests(requests: FilesystemRequest[]) {
  const script = await readFile(
    new URL("../src/sandbox/reviewer-filesystem.py", import.meta.url),
    "utf8",
  );
  const execution = execute("python3", ["-I", "-u", "-c", script], { timeout: 5000 });
  execution.child.stdin!.end(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
  return (await execution).stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

it("serves readiness and repeated canonical-path requests over one process", async () => {
  const responses = await filesystemRequests([
    { id: 1, operation: "ready" },
    { id: 2, operation: "canonical_paths", paths: ["/tmp/../tmp/deleted-source.ts"] },
    { id: 3, operation: "canonical_paths", paths: ["/tmp/a.ts", "/tmp/b.ts"] },
  ]);
  expect(responses).toEqual([
    { id: 1, result: true },
    { id: 2, result: ["/tmp/deleted-source.ts"] },
    { id: 3, result: ["/tmp/a.ts", "/tmp/b.ts"] },
  ]);
});

it("rejects read/write/command operations without ending the path-only transport", async () => {
  const responses = await filesystemRequests([
    { id: 1, operation: "write", path: "/tmp/private", content: "forbidden" },
    { id: 2, operation: "read", path: "/etc/passwd" },
    { id: 3, operation: "exec", command: "pwd" },
    { id: 4, operation: "ready" },
  ]);
  expect(responses).toEqual([
    { id: 1, error: "Unsupported reviewer filesystem operation" },
    { id: 2, error: "Unsupported reviewer filesystem operation" },
    { id: 3, error: "Unsupported reviewer filesystem operation" },
    { id: 4, result: true },
  ]);
});
