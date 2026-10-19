import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { readDevcontainerConfiguration } from "../src/sandbox/devcontainer-cli.ts";

const execute = promisify(execFile);
const engineScript = fileURLToPath(
  new URL("../src/sandbox/configuration-engine.mjs", import.meta.url),
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("returns an empty existing-container set for the pinned CLI's configuration discovery", async () => {
  const result = await execute(process.execPath, [
    engineScript,
    "ps",
    "-q",
    "-a",
    "--filter",
    "label=devcontainer.local_folder=/workspace",
    "--filter",
    "label=devcontainer.config_file=/private/devcontainer.json",
  ]);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

it.each([
  ["run", "debian"],
  ["build", "."],
  ["exec", "container", "sh"],
  ["inspect", "container"],
  ["ps", "-q", "-a", "--filter", "label=unrelated=container"],
  ["ps", "-q", "-a", "--filter"],
  ["ps", "--format", "json"],
])("refuses unsupported configuration-engine arguments %j", async (...args) => {
  await expect(execute(process.execPath, [engineScript, ...args])).rejects.toMatchObject({
    code: 1,
    stderr: "Configuration-only discovery cannot execute engine operations\n",
  });
});

it("reads and substitutes configuration without invoking Podman or host initialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "configuration-only-"));
  directories.push(directory);
  const workspaceFolder = join(directory, "project");
  const bin = join(directory, "bin");
  await mkdir(workspaceFolder);
  await mkdir(bin);
  const engineInvocation = join(directory, "engine-invoked");
  const initializationInvocation = join(directory, "initialization-invoked");
  const podman = join(bin, "podman");
  await writeFile(podman, '#!/bin/sh\nprintf invoked > "$ENGINE_SENTINEL"\nexit 99\n');
  await chmod(podman, 0o700);
  const configPath = join(directory, "devcontainer.json");
  await writeFile(
    configPath,
    JSON.stringify({
      image: "debian:bookworm",
      workspaceFolder: "${localWorkspaceFolder}",
      initializeCommand: [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(initializationInvocation)}, 'invoked')`,
      ],
    }),
  );
  const result = JSON.parse(
    await readDevcontainerConfiguration({
      configPath,
      workspaceFolder,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: directory,
        ENGINE_SENTINEL: engineInvocation,
      },
    }),
  );
  expect(result.configuration.workspaceFolder).toBe(workspaceFolder);
  expect(result.configuration.initializeCommand[0]).toBe(process.execPath);
  await expect(readFile(engineInvocation)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(initializationInvocation)).rejects.toMatchObject({ code: "ENOENT" });
});
