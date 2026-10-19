import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { publishPrivateText, readPrivateText } from "../src/sandbox/storage.ts";
import { MissingCatalogVersionError, catalogTool } from "../src/sandbox/tool-catalog.ts";
import { defaultToolProfile, resolveToolProfiles } from "../src/sandbox/tool-profile.ts";
import {
  startupRecoveryActions,
  switchProfileToolVersion,
} from "../src/sandbox/startup-recovery.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const failureContext = {
  globalToolsPath: "/agent/global/tools.json",
  projectToolsPath: "/agent/repos/project/devcontainer/tools.json",
  projectEnvironmentPath: "/agent/repos/project/devcontainer/project-environment.json",
  definitionPath: "/project/.devcontainer/devcontainer.json",
  hasStartupLog: true,
};

function profileWith(toolId: string, version: string) {
  const profile = defaultToolProfile();
  profile.tools[toolId] = { kind: "catalog", version };
  return profile;
}

it("names the profile entry, known versions, and replacement for a retired catalog pin", () => {
  const resolving = () =>
    resolveToolProfiles(profileWith("dotnet-runtime", "10.0.102"), undefined, undefined, {
      global: "/agent/global/tools.json",
    });
  expect(resolving).toThrow(MissingCatalogVersionError);
  expect(resolving).toThrow(
    "No verified tooling recipe for dotnet-runtime@10.0.102 (/agent/global/tools.json → tools.dotnet-runtime). This extension provides 10.0.109.",
  );
});

it("suggests reloading when a profile pins a version newer than this extension knows", () => {
  expect(() => catalogTool("dotnet-runtime", "10.0.200")).toThrow(
    "The profile may have been written by a newer pi-devcontainer-sandbox; /reload or update the extension.",
  );
});

it("offers a version switch, retry, rebuild, config, log, and sandbox-off for a retired pin", () => {
  const error = new MissingCatalogVersionError(
    "dotnet-runtime",
    "10.0.102",
    ["10.0.109"],
    "/agent/global/tools.json",
  );
  expect(startupRecoveryActions(error, failureContext).map((action) => action.label)).toEqual([
    "Switch dotnet-runtime 10.0.102 → 10.0.109",
    "Retry startup",
    "Rebuild (discard container state) and retry",
    "Edit dotnet-runtime in its tool profile",
    "Show the startup log path",
    "Turn sandbox off for this session",
    "Leave the sandbox unavailable",
  ]);
});

it("points a missing build prerequisite at the project tool profile", () => {
  const error = new Error(
    "Command failed: podman build\nMissing image prerequisite: node for playwright-chromium",
  );
  const openConfig = startupRecoveryActions(error, failureContext).find(
    (action) => action.kind === "open-config",
  );
  expect(openConfig).toEqual({
    kind: "open-config",
    label: "Edit playwright-chromium (needs node) in Sandbox Tools",
    path: failureContext.projectToolsPath,
  });
});

it("falls back to the devcontainer definition for an unclassified failure", () => {
  const actions = startupRecoveryActions(new Error("Invalid base definition"), {
    ...failureContext,
    hasStartupLog: false,
  });
  expect(actions.map((action) => action.kind)).toEqual([
    "retry",
    "rebuild",
    "open-config",
    "sandbox-off",
    "dismiss",
  ]);
  expect(actions[2]).toMatchObject({ path: failureContext.definitionPath });
});

it("rewrites only the failing tool entry to the replacement version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-recovery-"));
  directories.push(directory);
  const profilePath = join(directory, "tools.json");
  const profile = profileWith("dotnet-runtime", "10.0.102");
  await publishPrivateText(profilePath, JSON.stringify(profile), undefined);
  await switchProfileToolVersion(
    new MissingCatalogVersionError("dotnet-runtime", "10.0.102", ["10.0.109"], profilePath),
  );
  const saved = JSON.parse((await readPrivateText(profilePath))!.text);
  expect(saved.tools["dotnet-runtime"]).toEqual({ kind: "catalog", version: "10.0.109" });
  expect(saved.tools.jscpd).toEqual(profile.tools.jscpd);
});

it("refuses to rewrite a profile that changed after the failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-recovery-"));
  directories.push(directory);
  const profilePath = join(directory, "tools.json");
  await publishPrivateText(
    profilePath,
    JSON.stringify(profileWith("dotnet-runtime", "10.0.109")),
    undefined,
  );
  await expect(
    switchProfileToolVersion(
      new MissingCatalogVersionError("dotnet-runtime", "10.0.102", ["10.0.109"], profilePath),
    ),
  ).rejects.toThrow("changed since startup failed");
});
