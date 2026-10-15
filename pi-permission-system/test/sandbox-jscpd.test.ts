import { expect, it, vi } from "vitest";
import { catalogTool, REQUIRED_LANGUAGE_SERVERS } from "../src/sandbox/tool-catalog.ts";
import { jscpdDownload } from "../src/sandbox/tool-downloads.ts";
import { toolArtifactRecipe } from "../src/sandbox/tool-artifacts.ts";
import { resolveToolPlatform } from "../src/sandbox/tool-platform.ts";
import { defaultToolProfile, resolveToolProfiles } from "../src/sandbox/tool-profile.ts";
import { verifyRuntimeInventory } from "../src/sandbox/tool-build-runtime.ts";

it.each([
  {
    architecture: "amd64",
    distribution: "debian",
    release: "12",
    libc: "glibc",
    target: "x64-gnu",
  },
  {
    architecture: "arm64",
    distribution: "debian",
    release: "12",
    libc: "glibc",
    target: "arm64-gnu",
  },
  {
    architecture: "amd64",
    distribution: "alpine",
    release: "3.23",
    libc: "musl",
    target: "x64-musl",
  },
  {
    architecture: "arm64",
    distribution: "alpine",
    release: "3.23",
    libc: "musl",
    target: "arm64-musl",
  },
])("pins a self-contained jscpd archive for $target", ({ target, ...input }) => {
  const platform = resolveToolPlatform({ os: "linux", ...input });
  const download = jscpdDownload(platform);
  expect(download.url).toBe(
    `https://github.com/kucherenko/jscpd/releases/download/v5.4.1/jscpd-linux-${target}.tar.gz`,
  );
  expect(download.checksum).toMatch(/^[a-f0-9]{64}$/);
  const recipe = toolArtifactRecipe({
    tool: catalogTool("jscpd", "5.4.1"),
    platform,
    builderImageId: `sha256:${"a".repeat(64)}`,
    dependencies: [],
  });
  expect(recipe.files["install.sh"]).toContain(download.checksum);
  expect(recipe.files["install.sh"]).toContain("sha256sum --check");
  expect(recipe.files["install.sh"]).toContain("--version");
  expect(recipe.containerfile).toContain("FROM scratch AS artifact");
  expect(recipe.containerfile).toContain("/opt/pi-tools/jscpd/5.4.1/");
});
it("adds jscpd to new defaults without making old profiles invalid", () => {
  const profile = defaultToolProfile();
  expect(profile.tools.jscpd).toEqual({ kind: "catalog", version: "5.4.1" });
  expect(REQUIRED_LANGUAGE_SERVERS).not.toContain("jscpd");
  delete profile.tools.jscpd;
  expect(resolveToolProfiles(profile).some((tool) => tool.id === "jscpd")).toBe(false);
});
it("checks the actual jscpd runtime version", async () => {
  const tool = { ...catalogTool("jscpd", "5.4.1"), source: "global" as const, imageId: "image" };
  const inventory = {
    version: 1 as const,
    revision: "a".repeat(64),
    platform: "linux",
    tools: [tool],
  };
  const expectedVersionOutput = "jscpd 5.4.1\n";
  const run = vi.fn(async (args: string[]): Promise<string> => {
    if (args.at(-1) === "--version") {
      return expectedVersionOutput;
    }
    return "";
  });
  await verifyRuntimeInventory({ run, inventory, container: "guest", user: "developer" });
  expect(run).toHaveBeenCalledWith(
    ["exec", "--user", "developer", "--workdir", "/", "guest", tool.executable, "--version"],
    undefined,
  );
  run.mockResolvedValue("jscpd 4.0.0\n");
  await expect(
    verifyRuntimeInventory({ run, inventory, container: "guest", user: "developer" }),
  ).rejects.toThrow("version mismatch");
});
