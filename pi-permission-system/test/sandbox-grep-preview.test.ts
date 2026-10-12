import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

interface GrepPreview {
  output: string;
  stderr: string;
  code: number;
  truncated: boolean;
}

async function previewSyntheticSearch(producerScript: string, matchLimit: number): Promise<GrepPreview> {
  const script = await readFile(new URL("../src/sandbox/grep-preview.py", import.meta.url), "utf8");
  const execution = execute("python3", ["-u", "-c", script], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  execution.child.stdin!.end(JSON.stringify({
    arguments: ["python3", "-u", "-c", producerScript], limit: matchLimit,
  }));
  return JSON.parse((await execution).stdout) as GrepPreview;
}

it("stops at a global match limit across different source files", async () => {
  const producer = `import json
for index in range(100000):
    print(json.dumps({"type": "match", "data": {"path": {"text": f"file-{index}.ts"}, "lines": {"text": "needle\\n"}, "line_number": 1}}))
`;
  const preview = await previewSyntheticSearch(producer, 3);
  expect(preview.output.split("\n")).toEqual([
    "file-0.ts:1:needle", "file-1.ts:1:needle", "file-2.ts:1:needle",
  ]);
  expect(preview.truncated).toBe(true);
  expect(preview.code).toBe(0);
});

it("bounds one oversized JSON record before buffering its full line", async () => {
  const producer = 'import sys\nsys.stdout.write("{" + "x" * (4 * 1024 * 1024))\nsys.stdout.flush()';
  const preview = await previewSyntheticSearch(producer, 100);
  expect(preview.output).toBe("");
  expect(preview.truncated).toBe(true);
  expect(preview.code).toBe(0);
});

it("drains large stderr without blocking stdout and retains only its bounded preview", async () => {
  const producer = `import json
import sys
sys.stderr.write("warning " * 100000)
sys.stderr.flush()
print(json.dumps({"type": "match", "data": {"path": {"text": "app.ts"}, "lines": {"text": "needle\\n"}, "line_number": 2}}))
`;
  const preview = await previewSyntheticSearch(producer, 100);
  expect(preview.output).toBe("app.ts:2:needle");
  expect(Buffer.byteLength(preview.stderr)).toBe(16000);
  expect(preview.truncated).toBe(false);
  expect(preview.code).toBe(0);
});
