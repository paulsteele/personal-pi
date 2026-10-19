import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createMountGrant,
  reapproveReplacedMounts,
  validateMountIdentity,
} from "../src/sandbox/mounts.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function mountFixture(access: "ro" | "rw" = "rw") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sandbox-mounts-")));
  directories.push(directory);
  const source = join(directory, "config.json");
  const privateStorage = join(directory, "private");
  await mkdir(privateStorage);
  await writeFile(source, '{"model":"original"}');
  const grant = await createMountGrant({
    path: source,
    destination: "/config.json",
    access,
    privateStorage,
  });
  const confirm = vi.fn(async (_preview: string, _signal: AbortSignal) => true);
  const options = {
    mounts: [grant],
    privateStorage,
    confirm,
    signal: new AbortController().signal,
  };
  const replaceFile = async () => {
    const temporary = join(directory, "replacement.json");
    await writeFile(temporary, '{"model":"replacement"}');
    await rename(temporary, source);
  };
  return { grant, source, directory, options, confirm, replaceFile };
}

it("retains unchanged mount grants without asking for renewed approval", async () => {
  const fixture = await mountFixture();
  expect(await reapproveReplacedMounts(fixture.options)).toEqual([fixture.grant]);
  expect(fixture.confirm).not.toHaveBeenCalled();
});

it.each(["ro", "rw"] as const)(
  "requires approval for an atomically replaced %s file and preserves its path and access",
  async (access) => {
    const fixture = await mountFixture(access);
    await fixture.replaceFile();
    await expect(validateMountIdentity(fixture.grant)).rejects.toThrow("source was replaced");
    const [replacement] = await reapproveReplacedMounts(fixture.options);
    expect(fixture.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`Source: ${fixture.source}`),
      fixture.options.signal,
    );
    expect(fixture.confirm.mock.calls[0][0]).toContain(`Access: ${access}`);
    expect(replacement).toEqual({ ...fixture.grant, identity: expect.any(String) });
    expect(replacement.identity).not.toBe(fixture.grant.identity);
    await expect(validateMountIdentity(replacement)).resolves.toBeUndefined();
  },
);

it("leaves the original grant unchanged when replacement approval is denied", async () => {
  const fixture = await mountFixture();
  const approvedIdentity = fixture.grant.identity;
  await fixture.replaceFile();
  fixture.confirm.mockResolvedValue(false);
  await expect(reapproveReplacedMounts(fixture.options)).rejects.toThrow(
    "Replacement host mount was not approved",
  );
  expect(fixture.grant.identity).toBe(approvedIdentity);
});

it("rejects another replacement during the approval dialog", async () => {
  const fixture = await mountFixture();
  await fixture.replaceFile();
  fixture.confirm.mockImplementation(async () => {
    await fixture.replaceFile();
    return true;
  });
  await expect(reapproveReplacedMounts(fixture.options)).rejects.toThrow("source was replaced");
});

it.each(["missing", "directory", "symlink"] as const)(
  "blocks a %s source without offering inode reapproval",
  async (replacementKind) => {
    const fixture = await mountFixture();
    await rm(fixture.source);
    if (replacementKind === "directory") {
      await mkdir(fixture.source);
    }
    if (replacementKind === "symlink") {
      const target = join(fixture.directory, "target.json");
      await writeFile(target, "{}");
      await symlink(target, fixture.source);
    }
    await expect(reapproveReplacedMounts(fixture.options)).rejects.toThrow();
    expect(fixture.confirm).not.toHaveBeenCalled();
  },
);

it("blocks a cancelled reload before offering replacement approval", async () => {
  const fixture = await mountFixture();
  await fixture.replaceFile();
  await expect(
    reapproveReplacedMounts({ ...fixture.options, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(fixture.confirm).not.toHaveBeenCalled();
});
