import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { startEngineAdapter } from "../src/sandbox/engine-server.ts";
import { validateImageIsolation } from "../src/sandbox/metadata-policy.ts";
import { devcontainerPorts } from "../src/sandbox/ports.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
  directories.length = 0;
});

it("runs authorized adapter requests and refuses unknown commands before host execution", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sandbox-adapter-")));
  directories.push(directory);
  const server = await startEngineAdapter({
    socketPath: join(directory, "engine.sock"),
    executable: "/bin/echo",
    authority: {
      label: "pi.sandbox.session=test",
      containerName: "pi-project-test-g1",
      containerLabels: {},
      containers: [],
      images: [],
      imageNames: [],
      contexts: [],
      containerfiles: [],
      mounts: [],
      volumes: [],
      ports: [],
      environment: {},
      users: [],
    },
  });
  const adapter = fileURLToPath(new URL("../src/sandbox/engine-adapter.mjs", import.meta.url));
  async function runAdapterProcess(args: string[]) {
    const child = spawn(process.execPath, [adapter, ...args], {
      env: { ...process.env, ...server.environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    return { code, stdout, stderr };
  }
  try {
    const allowed = await runAdapterProcess(["version"]);
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toBe("version\n");
    const blocked = await runAdapterProcess(["system", "prune"]);
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toBe("");
    expect(blocked.stderr).toContain("Unsupported engine command");
  } finally {
    await server.close();
  }
});

it.each([
  { privileged: true },
  { capAdd: ["SYS_ADMIN"] },
  { securityOpt: ["seccomp=unconfined"] },
  { mounts: ["type=bind,source=/home,target=/host"] },
])("rejects image metadata that changes sandbox authority %j", (metadata) => {
  expect(() =>
    validateImageIsolation({
      Id: "sha256:image",
      Config: { Labels: { "devcontainer.metadata": JSON.stringify([metadata]) } },
    }),
  ).toThrow();
});

it("rejects anonymous image volumes and accepts ordinary tool metadata", () => {
  expect(() =>
    validateImageIsolation({ Id: "sha256:image", Config: { Volumes: { "/data": {} } } }),
  ).toThrow("anonymous");
  expect(() =>
    validateImageIsolation({
      Id: "sha256:image",
      Config: { Labels: { "devcontainer.metadata": '[{"remoteUser":"node"}]' } },
    }),
  ).not.toThrow();
});

it("accepts only valid numeric or localhost forwarding destinations", () => {
  expect(devcontainerPorts([3000, "localhost:3000", 8080])).toEqual([3000, 8080]);
  expect(() => devcontainerPorts(["other-service:3000"])).toThrow();
  expect(() => devcontainerPorts([65536])).toThrow();
});
