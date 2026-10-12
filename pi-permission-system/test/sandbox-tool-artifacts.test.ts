import { expect, it } from "vitest";
import { STANDARD_TOOL_CATALOG } from "../src/sandbox/tool-catalog.ts";
import { toolArtifactRecipe } from "../src/sandbox/tool-artifacts.ts";
import { toolBuilderReference } from "../src/sandbox/tool-builders.ts";
import { toolRuntimeDownload } from "../src/sandbox/tool-downloads.ts";
import { resolveToolPlatform } from "../src/sandbox/tool-platform.ts";

const releases = [
  { distribution: "debian", release: "12", libc: "glibc" },
  { distribution: "debian", release: "13", libc: "glibc" },
  { distribution: "ubuntu", release: "22.04", libc: "glibc" },
  { distribution: "ubuntu", release: "24.04", libc: "glibc" },
  { distribution: "alpine", release: "3.21", libc: "musl" },
  { distribution: "alpine", release: "3.22", libc: "musl" },
  { distribution: "alpine", release: "3.23", libc: "musl" },
];

it.each(
  releases.flatMap(({ distribution, release, libc }) =>
    ["amd64", "arm64"].map((architecture) => ({
      os: "linux",
      architecture,
      distribution,
      release,
      libc,
    })),
  ),
)("pins builders and runtime archives for $distribution $release $architecture", (input) => {
  const platform = resolveToolPlatform(input);
  expect(toolBuilderReference(platform)).toMatch(
    /^docker\.io\/library\/[a-z]+@sha256:[a-f0-9]{64}$/,
  );
  for (const tool of STANDARD_TOOL_CATALOG.filter(
    (tool) => tool.role === "runtime" || tool.id === "rust-analyzer",
  )) {
    const download = toolRuntimeDownload(tool.id, platform);
    expect(download.url).toMatch(/^https:\/\//);
    expect(download.checksum).toMatch(
      new RegExp(`^[a-f0-9]{${download.algorithm === "sha256" ? 64 : 128}}$`),
    );
  }
});

it("accepts Node's x64 platform spelling", () => {
  const platform = resolveToolPlatform({
    os: "linux",
    architecture: "x64",
    distribution: "debian",
    release: "12",
    libc: "glibc",
  });
  expect(platform.architecture).toBe("amd64");
});

it("exports only the selected server prefix from its independent build stage", () => {
  const tool = STANDARD_TOOL_CATALOG.find((entry) => entry.id === "pyright")!;
  const node = STANDARD_TOOL_CATALOG.find((entry) => entry.id === "node-runtime")!;
  const recipe = toolArtifactRecipe({
    tool,
    platform: resolveToolPlatform({
      os: "linux",
      architecture: "arm64",
      distribution: "alpine",
      release: "3.23",
      libc: "musl",
    }),
    builderImageId: `sha256:${"a".repeat(64)}`,
    dependencies: [{ tool: node, imageId: `sha256:${"b".repeat(64)}` }],
  });
  const artifactStage = recipe.containerfile.split("FROM scratch AS artifact")[1];
  expect(artifactStage).toBe(
    "\nCOPY --from=build /opt/pi-tools/pyright/1.1.414/ /opt/pi-tools/pyright/1.1.414/\n",
  );
  expect(recipe.files["install.sh"]).toContain("sha512sum --check");
  expect(recipe.files["install.sh"]).toContain(node.executable);
  expect(recipe.files["install.sh"]).not.toContain("npm install");
});

it("builds Node against musl rather than copying a glibc archive", () => {
  const recipe = toolArtifactRecipe({
    tool: STANDARD_TOOL_CATALOG.find((entry) => entry.id === "node-runtime")!,
    platform: resolveToolPlatform({
      os: "linux",
      architecture: "arm64",
      distribution: "alpine",
      release: "3.21",
      libc: "musl",
    }),
    builderImageId: `sha256:${"a".repeat(64)}`,
    dependencies: [],
  });
  expect(recipe.files["install.sh"]).toContain("node-v24.21.0.tar.xz");
  expect(recipe.files["install.sh"]).toContain("./configure --prefix=");
  expect(recipe.files["install.sh"]).toContain("make install");
});
