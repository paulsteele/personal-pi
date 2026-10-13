import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GuestFilesystem } from "../src/sandbox/filesystem.ts";
import type { GuestProcessOptions } from "../src/sandbox/process.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function executeFilesystemPython(options: GuestProcessOptions) {
  const child = spawn(options.command[0]!, options.command.slice(1), {
    cwd: options.cwd,
    env: { ...process.env, ...options.environment },
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (data: Buffer) => stdout.push(data));
  child.stderr.on("data", (data: Buffer) => stderr.push(data));
  const finished = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  child.stdin.end(options.input);
  return {
    code: await finished,
    output: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr).toString(),
  };
}

async function filesystemFixture() {
  const directory = await mkdtemp(join(tmpdir(), "guest-filesystem-process-"));
  directories.push(directory);
  const home = join(directory, "home");
  await mkdir(home);
  const filesystem = new GuestFilesystem(
    () => ({
      container: "fixture",
      image: "fixture",
      user: "fixture",
      workspace: directory,
      configuration: {},
      remoteEnvironment: { HOME: home },
    }),
    executeFilesystemPython,
  );
  return { directory, home, filesystem };
}

it("writes and reads workspace files through the real guest filesystem protocol", async () => {
  const fixture = await filesystemFixture();
  await fixture.filesystem.mkdir("nested");
  await fixture.filesystem.write("nested/result.ts", "const sandboxed = true;\n");
  expect((await fixture.filesystem.read("nested/result.ts")).toString()).toBe(
    "const sandboxed = true;\n",
  );
  expect(await readFile(join(fixture.directory, "nested/result.ts"), "utf8")).toBe(
    "const sandboxed = true;\n",
  );
  expect(await fixture.filesystem.list("nested")).toEqual(["result.ts"]);
});

it("allows access to a readable file through the real guest filesystem protocol", async () => {
  const fixture = await filesystemFixture();
  await fixture.filesystem.write("readable.txt", "guest contents");
  await expect(fixture.filesystem.access("readable.txt")).resolves.toBeUndefined();
});

it("reports guest and host absence for a missing path through the real guest filesystem protocol", async () => {
  const fixture = await filesystemFixture();
  const missingPath = join(fixture.directory, "missing");
  const failure = fixture.filesystem.access("missing");
  await expect(failure).rejects.toMatchObject({ name: "PermissionError" });
  await expect(failure).rejects.toThrow(
    `Guest status: ${JSON.stringify({
      path: missingPath,
      exists: false,
      readable: false,
    })}`,
  );
  await expect(failure).rejects.toThrow(`Host path checked: ${missingPath}`);
  await expect(failure).rejects.toThrow('Host status: {"exists":false}');
  await expect(failure).rejects.toThrow("call request_host_mount");
});

it("resolves guest HOME and batch entry probes in the Python process namespace", async () => {
  const fixture = await filesystemFixture();
  await fixture.filesystem.write("~/present", "guest home");
  await symlink("missing-target", join(fixture.directory, "dangling-link"));
  expect(await fixture.filesystem.canonical("~")).toBe(fixture.home);
  expect(await fixture.filesystem.canonicalPaths(["~/present", "nested/../missing"])).toEqual([
    join(fixture.home, "present"),
    join(fixture.directory, "missing"),
  ]);
  expect(
    await fixture.filesystem.entriesExist([
      join(fixture.home, "present"),
      "missing",
      "dangling-link",
    ]),
  ).toEqual([true, false, true]);
});
