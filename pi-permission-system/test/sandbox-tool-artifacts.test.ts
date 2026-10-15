import { expect, it } from "vitest";
import {
  catalogTool,
  catalogToolPrefix,
  STANDARD_TOOL_CATALOG,
} from "../src/sandbox/tool-catalog.ts";
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

it.each([
  { architecture: "amd64", distribution: "debian", release: "12", libc: "glibc" },
  { architecture: "arm64", distribution: "debian", release: "12", libc: "glibc" },
  { architecture: "amd64", distribution: "alpine", release: "3.23", libc: "musl" },
  { architecture: "arm64", distribution: "alpine", release: "3.23", libc: "musl" },
])("marks Roslyn's native child executable on $libc $architecture", (input) => {
  const tool = catalogTool("roslyn", "5.12.0-1.26426.8");
  const dotnet = catalogTool("dotnet-runtime", "10.0.109");
  const recipe = toolArtifactRecipe({
    tool,
    platform: resolveToolPlatform({ os: "linux", ...input }),
    builderImageId: `sha256:${"a".repeat(64)}`,
    dependencies: [{ tool: dotnet, imageId: `sha256:${"b".repeat(64)}` }],
  });
  const nativeServer = `${catalogToolPrefix(tool)}/Microsoft.CodeAnalysis.LanguageServer`;
  expect(recipe.files["install.sh"]).toContain(`chmod 755 '${nativeServer}'\n`);
  expect(recipe.files["install.sh"]).toContain(`chmod 755 '${tool.executable}'\n`);
});

it("uses the .NET 10.0.9 runtime for the Roslyn artifact", () => {
  const dotnet = catalogTool("dotnet-runtime", "10.0.109");
  const recipe = toolArtifactRecipe({
    tool: catalogTool("roslyn", "5.12.0-1.26426.8"),
    platform: resolveToolPlatform({
      os: "linux",
      architecture: "arm64",
      distribution: "debian",
      release: "13",
      libc: "glibc",
    }),
    builderImageId: `sha256:${"a".repeat(64)}`,
    dependencies: [{ tool: dotnet, imageId: `sha256:${"b".repeat(64)}` }],
  });
  expect(recipe.files["install.sh"]).toContain("/opt/pi-tools/dotnet-runtime/10.0.109/dotnet");
  expect(recipe.files["install.sh"]).not.toContain("10.0.102");
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
