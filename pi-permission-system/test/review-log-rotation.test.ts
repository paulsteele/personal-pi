import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ReviewLogger } from "../src/logging.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("rotates the review log to a single previous file once it reaches the size limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-log-"));
  directories.push(directory);
  const path = join(directory, "review.jsonl");
  const rotationBytes = 200;
  const logger = new ReviewLogger(path, rotationBytes);
  logger.review("first", { note: "x".repeat(rotationBytes) });
  logger.review("second");
  expect(await readFile(`${path}.1`, "utf8")).toContain('"event":"first"');
  const current = await readFile(path, "utf8");
  expect(current).toContain('"event":"second"');
  expect(current).not.toContain('"event":"first"');
});
