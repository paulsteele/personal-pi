import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { authorizeBuildInputs } from "../src/sandbox/build-inputs.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function buildFixture() {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-build-authority-"));
  directories.push(directory);
  const projectRoot = join(directory, "project");
  const privateStorage = join(directory, "agent", "extensions", "pi-permission-system");
  const definitionPath = join(privateStorage, "global", "devcontainer.json");
  await mkdir(projectRoot);
  await mkdir(dirname(definitionPath), { recursive: true });
  await writeFile(
    definitionPath,
    '{"build":{"dockerfile":"recipe/Containerfile","context":"recipe"}}',
  );
  const buildContext = join(dirname(definitionPath), "recipe");
  const containerfile = join(buildContext, "Containerfile");
  await mkdir(buildContext);
  await writeFile(containerfile, "FROM scratch\n");
  return { directory, projectRoot, privateStorage, definitionPath, buildContext, containerfile };
}

it("accepts private companion recipes without granting other private authority", async () => {
  const fixture = await buildFixture();
  const confirm = vi.fn(async () => false);
  await authorizeBuildInputs({ ...fixture, confirm });
  expect(confirm).not.toHaveBeenCalled();
});

it.each([
  "config.json",
  "host-commands.json",
  "owner.lock",
  "session.json",
  "project-environment.json",
])("rejects nested %s authority in a private recipe context", async (authorityFilename) => {
  const fixture = await buildFixture();
  const nested = join(fixture.buildContext, "nested");
  await mkdir(nested);
  await writeFile(join(nested, authorityFilename), "private authority");
  await expect(authorizeBuildInputs(fixture)).rejects.toThrow("exposes private sandbox authority");
});

it("rejects another session's private config even when the active session directory differs", async () => {
  const fixture = await buildFixture();
  const config = join(fixture.privateStorage, "repos", "other", "config.json");
  await mkdir(dirname(config), { recursive: true });
  await writeFile(config, "private authority");
  const confirm = vi.fn(async () => true);
  await expect(
    authorizeBuildInputs({ ...fixture, containerfile: config, confirm }),
  ).rejects.toThrow("exposes private sandbox authority");
  expect(confirm).not.toHaveBeenCalled();
});

it("rejects project context links into private authority before building", async () => {
  const fixture = await buildFixture();
  await symlink(fixture.privateStorage, join(fixture.projectRoot, "authority"));
  await expect(
    authorizeBuildInputs({ ...fixture, buildContext: fixture.projectRoot }),
  ).rejects.toThrow("exposes private sandbox authority");
});

it("requires independent consent for external build input and detects replacement during approval", async () => {
  const fixture = await buildFixture();
  const external = join(fixture.directory, "external");
  const replacement = join(fixture.directory, "replacement");
  await mkdir(external);
  await mkdir(replacement);
  await expect(
    authorizeBuildInputs({ ...fixture, buildContext: external, confirm: async () => false }),
  ).rejects.toThrow("not authorized");
  const confirm = vi.fn(async () => {
    await rename(external, `${external}-old`);
    await rename(replacement, external);
    return true;
  });
  await expect(
    authorizeBuildInputs({ ...fixture, buildContext: external, confirm }),
  ).rejects.toThrow("changed during approval");
  expect(confirm).toHaveBeenCalledOnce();
});
