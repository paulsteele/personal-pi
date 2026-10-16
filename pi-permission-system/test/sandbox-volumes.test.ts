import { expect, it, vi } from "vitest";
import {
  guestToHost,
  hostToGuest,
  isGuestPathInVolume,
  type MountGrant,
} from "../src/sandbox/mounts.ts";
import {
  ensureProjectVolume,
  projectVolumeGrant,
  projectVolumeName,
  validateVolumeTopology,
  volumeMountArgument,
} from "../src/sandbox/volumes.ts";

const projectRoot = "/projects/sep/defaults/main";
const workspaceBind: MountGrant = {
  source: projectRoot,
  destination: "/workspaces/defaults",
  access: "rw",
  identity: "1:2",
  kind: "directory",
};
const nodeModulesVolume = projectVolumeGrant({
  projectRoot,
  destination: "/workspaces/defaults/node_modules",
  access: "rw",
});

it("names volumes stably per checkout and destination", () => {
  const name = projectVolumeName(projectRoot, "/workspaces/defaults/node_modules");
  expect(name).toMatch(/^pi-vol-main-[a-f0-9]{16}$/);
  expect(projectVolumeName(projectRoot, "/workspaces/defaults/node_modules")).toBe(name);
  expect(projectVolumeName(projectRoot, "/workspaces/defaults/.svelte-kit")).not.toBe(name);
  expect(
    projectVolumeName("/projects/worktrees/main", "/workspaces/defaults/node_modules"),
  ).not.toBe(name);
});

it("renders read-write and read-only volume mount arguments", () => {
  expect(volumeMountArgument(nodeModulesVolume)).toBe(
    `type=volume,source=${nodeModulesVolume.name},target=/workspaces/defaults/node_modules`,
  );
  expect(volumeMountArgument({ ...nodeModulesVolume, access: "ro" })).toBe(
    `type=volume,source=${nodeModulesVolume.name},target=/workspaces/defaults/node_modules,readonly`,
  );
});

it("rejects volume destinations on protected guest roots", () => {
  expect(() => projectVolumeGrant({ projectRoot, destination: "/usr/lib", access: "rw" })).toThrow(
    "protected guest root",
  );
});

it("allows a volume nested inside the workspace bind", () => {
  expect(() => validateVolumeTopology([workspaceBind], [nodeModulesVolume])).not.toThrow();
});

it("rejects a host bind nested inside a volume", () => {
  const nestedBind: MountGrant = {
    ...workspaceBind,
    source: "/host/cache",
    destination: "/workspaces/defaults/node_modules/.cache",
  };
  expect(() => validateVolumeTopology([workspaceBind, nestedBind], [nodeModulesVolume])).toThrow(
    "cannot be nested inside volume",
  );
});

it("rejects overlapping volume destinations", () => {
  const nestedVolume = projectVolumeGrant({
    projectRoot,
    destination: "/workspaces/defaults/node_modules/.vite",
    access: "rw",
  });
  expect(() => validateVolumeTopology([], [nodeModulesVolume, nestedVolume])).toThrow(
    "Conflicting volume destinations",
  );
});

it("identifies guest paths stored in a volume", () => {
  expect(isGuestPathInVolume("/workspaces/defaults/node_modules", [nodeModulesVolume])).toBe(true);
  expect(
    isGuestPathInVolume("/workspaces/defaults/node_modules/vite/bin", [nodeModulesVolume]),
  ).toBe(true);
  expect(isGuestPathInVolume("/workspaces/defaults/src", [nodeModulesVolume])).toBe(false);
});

it("gives volume-backed guest paths no host mapping even inside a host bind", () => {
  const volumes = [nodeModulesVolume];
  expect(guestToHost("/workspaces/defaults/node_modules/vite", [workspaceBind], volumes)).toBe(
    undefined,
  );
  expect(guestToHost("/workspaces/defaults/src/app.ts", [workspaceBind], volumes)).toBe(
    `${projectRoot}/src/app.ts`,
  );
  expect(hostToGuest(`${projectRoot}/node_modules/vite`, [workspaceBind], volumes)).toBe(undefined);
  expect(hostToGuest(`${projectRoot}/src/app.ts`, [workspaceBind], volumes)).toBe(
    "/workspaces/defaults/src/app.ts",
  );
});

it("creates a missing project volume with ownership labels", async () => {
  const run = vi.fn(async (_args: string[]) => "");
  await ensureProjectVolume({ run, volume: nodeModulesVolume, projectRoot });
  expect(run).toHaveBeenLastCalledWith(
    [
      "volume",
      "create",
      "--label",
      "pi.sandbox.volume=1",
      "--label",
      `pi.sandbox.project-root=${projectRoot}`,
      nodeModulesVolume.name,
    ],
    undefined,
  );
});

it("reuses an existing project volume owned by the same checkout", async () => {
  const run = vi.fn(async (args: string[]) => {
    if (args[1] === "ls") {
      return `${nodeModulesVolume.name}\n`;
    }
    return JSON.stringify([
      { Name: nodeModulesVolume.name, Labels: { "pi.sandbox.project-root": projectRoot } },
    ]);
  });
  await ensureProjectVolume({ run, volume: nodeModulesVolume, projectRoot });
  expect(run).not.toHaveBeenCalledWith(expect.arrayContaining(["create"]), undefined);
});

it("refuses a same-named volume labeled for another checkout", async () => {
  const run = vi.fn(async (args: string[]) => {
    if (args[1] === "ls") {
      return nodeModulesVolume.name;
    }
    return JSON.stringify([
      { Name: nodeModulesVolume.name, Labels: { "pi.sandbox.project-root": "/elsewhere" } },
    ]);
  });
  await expect(
    ensureProjectVolume({ run, volume: nodeModulesVolume, projectRoot }),
  ).rejects.toThrow("belongs to another checkout");
});
