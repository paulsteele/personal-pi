import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GuestFilesystem } from "../src/sandbox/filesystem.ts";
import type { MountGrant } from "../src/sandbox/mounts.ts";
import type { GuestProcessOptions } from "../src/sandbox/process.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function hostPathFixture(kind: "file" | "directory" | "missing") {
  const directory = await mkdtemp(join(tmpdir(), "guest-access-host-"));
  directories.push(directory);
  const path = join(directory, "requested");
  if (kind === "file") {
    await writeFile(path, "host-only contents");
  }
  if (kind === "directory") {
    await mkdir(path);
  }
  return path;
}

function accessFixture(options: {
  guestPath: string;
  guestExists?: boolean;
  guestReadable?: boolean;
  mounts?: readonly MountGrant[];
  statHostPath?: (path: string) => Promise<{ isFile(): boolean; isDirectory(): boolean }>;
}) {
  const execute = vi.fn(async (_request: GuestProcessOptions) => ({
    code: 0,
    output: Buffer.from(
      JSON.stringify({
        path: options.guestPath,
        exists: options.guestExists ?? false,
        readable: options.guestReadable ?? false,
      }),
    ),
    stderr: "",
  }));
  const filesystem = new GuestFilesystem(
    () => ({
      container: "fixture",
      image: "fixture",
      user: "fixture",
      workspace: "/workspace",
      configuration: {},
    }),
    execute,
    { mounts: () => options.mounts ?? [], statHostPath: options.statHostPath },
  );
  return { filesystem, execute };
}

it.each(["file", "directory"] as const)(
  "reports an existing unmounted host %s and a read-only mount request",
  async (kind) => {
    const hostPath = await hostPathFixture(kind);
    const fixture = accessFixture({ guestPath: hostPath });
    const failure = fixture.filesystem.access(hostPath);
    await expect(failure).rejects.toMatchObject({ name: "PermissionError" });
    await expect(failure).rejects.toThrow(
      `Guest status: ${JSON.stringify({ path: hostPath, exists: false, readable: false })}`,
    );
    await expect(failure).rejects.toThrow(`Host path checked: ${hostPath}`);
    await expect(failure).rejects.toThrow(`Host status: ${JSON.stringify({ exists: true, kind })}`);
    await expect(failure).rejects.toThrow("Covered by approved mount: false");
    await expect(failure).rejects.toThrow(
      `call request_host_mount with ${JSON.stringify({
        path: hostPath,
        destination: hostPath,
        access: "ro",
        reason: "Read the requested host file or directory from the sandbox",
      })}`,
    );
    await expect(failure).rejects.toThrow(
      "After human approval, retry using the returned destination",
    );
  },
);

it("reports a missing host path and tells the model to correct it before requesting access", async () => {
  const hostPath = await hostPathFixture("missing");
  const fixture = accessFixture({ guestPath: hostPath });
  const failure = fixture.filesystem.access(hostPath);
  await expect(failure).rejects.toThrow('Host status: {"exists":false}');
  await expect(failure).rejects.toThrow(
    "The checked host path does not exist; correct the path first",
  );
  await expect(failure).rejects.toThrow(
    'call request_host_mount with its absolute host path, access: "ro"',
  );
});

it("reports an unknown host status when host metadata access is denied", async () => {
  const statHostPath = vi.fn(async (_path: string) => {
    throw Object.assign(new Error("Host metadata denied"), { code: "EACCES" });
  });
  const fixture = accessFixture({ guestPath: "/host/private/docs", statHostPath });
  const failure = fixture.filesystem.access("/host/private/docs");
  await expect(failure).rejects.toThrow('Host status: {"exists":"unknown","errorCode":"EACCES"}');
  await expect(failure).rejects.toThrow(
    "Verify that the host path is an existing regular file or directory first",
  );
  await expect(failure).rejects.toThrow("call request_host_mount");
  expect(statHostPath).toHaveBeenCalledWith("/host/private/docs");
});

it("checks the mapped host source for an unreadable guest path already covered by a mount", async () => {
  const statHostPath = vi.fn(async (_path: string) => ({
    isFile: () => true,
    isDirectory: () => false,
  }));
  const fixture = accessFixture({
    guestPath: "/guest/docs/README.md",
    guestExists: true,
    statHostPath,
    mounts: [
      {
        source: "/host/docs",
        destination: "/guest/docs",
        access: "ro",
        kind: "directory",
        identity: "1:2",
      },
    ],
  });
  const failure = fixture.filesystem.access("/guest/docs/README.md");
  await expect(failure).rejects.toThrow('"exists":true,"readable":false');
  await expect(failure).rejects.toThrow("Host path checked: /host/docs/README.md");
  await expect(failure).rejects.toThrow("Covered by approved mount: true");
  await expect(failure).rejects.toThrow(
    "check guest permissions or a missing path rather than requesting the same mount again",
  );
  expect(statHostPath).toHaveBeenCalledWith("/host/docs/README.md");
});

it("uses the resolved guest path for host diagnostics and an explicit mount destination", async () => {
  const statHostPath = vi.fn(async (_path: string) => ({
    isFile: () => false,
    isDirectory: () => true,
  }));
  const fixture = accessFixture({ guestPath: "/workspace/docs", statHostPath });
  const failure = fixture.filesystem.access("docs");
  await expect(failure).rejects.toThrow("Guest access failed for docs");
  await expect(failure).rejects.toThrow('"destination":"/workspace/docs"');
  expect(statHostPath).toHaveBeenCalledWith("/workspace/docs");
});

it("bounds a stalled host metadata lookup and retains guest recovery guidance", async () => {
  const statHostPath = vi.fn(() => new Promise<never>(() => {}));
  const fixture = accessFixture({ guestPath: "/host/stalled", statHostPath });
  const failure = fixture.filesystem.access("/host/stalled");
  await expect(failure).rejects.toThrow(
    'Host status: {"exists":"unknown","errorCode":"ETIMEDOUT"}',
  );
  await expect(failure).rejects.toThrow("Guest access failed for /host/stalled");
  await expect(failure).rejects.toThrow("call request_host_mount");
});

it("cancels a pending advisory metadata lookup with the caller", async () => {
  const controller = new AbortController();
  const statHostPath = vi.fn(() => new Promise<never>(() => {}));
  const fixture = accessFixture({ guestPath: "/host/stalled", statHostPath });
  const failure = fixture.filesystem.access("/host/stalled", controller.signal);
  const rejected = expect(failure).rejects.toThrow("Caller cancelled");
  await vi.waitFor(() => expect(statHostPath).toHaveBeenCalledOnce());
  controller.abort(new Error("Caller cancelled"));
  await rejected;
});

it("does not inspect the host when the guest path is readable", async () => {
  const statHostPath = vi.fn();
  const fixture = accessFixture({
    guestPath: "/workspace/README.md",
    guestExists: true,
    guestReadable: true,
    statHostPath,
  });
  await expect(fixture.filesystem.access("README.md")).resolves.toBeUndefined();
  expect(statHostPath).not.toHaveBeenCalled();
});
