import { catalogTool, catalogToolPrefix, type CatalogTool } from "./tool-catalog.ts";
import { shellQuote } from "./image-tool-recipe.ts";
import { toolRuntimeDownload, type PinnedDownload } from "./tool-downloads.ts";
import {
  dotnetRuntimeIdentifier,
  rustDistributionTarget,
  type ToolPlatform,
} from "./tool-platform.ts";
import type { GeneratedImageRecipe, ToolArtifactImage } from "./tool-assembly.ts";

const roslynChecksums: Record<string, string> = {
  "linux-x64": "50f88435f5875640fb2341878618dbfaec4354a1a134efcac0ae557247448a58",
  "linux-arm64": "d2b60ac1d4fd41c19dfdcd940822793e2a9aac630ed547be277fd713d6ed666d",
  "linux-musl-x64": "48fae842918c05ded7fcc54d3bb4003ead1c514e24619b40fc8aae39bc4bc0b2",
  "linux-musl-arm64": "a7625416735dc75809cc86295c78d181f0bcd4a0e55aeacc9b9505e60f413939",
};
const npmArtifacts: Record<string, { version: string; integrity: string; main: string }> = {
  "typescript-language-server": {
    version: "6.0.1",
    integrity:
      "c5hEHM/7rdFRbQWoHXuddyJ53oF0M2dKeXQOYdwUek556oarltKeumKJGLp/ZMcGV7gW30mGn1MR3V5GDiLiKg==",
    main: "lib/cli.mjs",
  },
  typescript: {
    version: "5.9.3",
    integrity:
      "jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==",
    main: "bin/tsc",
  },
  pyright: {
    version: "1.1.414",
    integrity:
      "FPZZb51jepDX4eP7TEYDeNFtmE3WgwkkEcJpvH3/QmUSsj0EAy3LXu+xB4T/FWDejtsXlCfFr/rbWFjwuwuXww==",
    main: "langserver.index.js",
  },
};

export function nativeToolDependencies(platform: ToolPlatform, building = false): string {
  if (platform.distribution === "alpine") {
    const packages = [
      "bash",
      "python3",
      "ripgrep",
      "git",
      "ca-certificates",
      "curl",
      "tar",
      "xz",
      "unzip",
      "libgcc",
      "libstdc++",
      "libssl3",
      "icu-libs",
      "icu-data-full",
      "tzdata",
      "krb5-libs",
    ];
    if (building) {
      packages.push("build-base", "linux-headers", "perl");
    }
    return `set -eu\napk add --no-cache ${packages.join(" ")}\n`;
  }
  const packages = [
    "bash",
    "python3",
    "ripgrep",
    "git",
    "ca-certificates",
    "curl",
    "tar",
    "xz-utils",
    "unzip",
    "libgcc-s1",
    "libstdc++6",
    "zlib1g",
    "libkrb5-3",
    "tzdata",
  ];
  const modernSsl =
    (platform.distribution === "ubuntu" && platform.release === "24.04") ||
    (platform.distribution === "debian" && platform.release === "13");
  packages.push(modernSsl ? "libssl3t64" : "libssl3");
  const icuPackages: Record<string, string> = {
    "ubuntu-22.04": "libicu70",
    "ubuntu-24.04": "libicu74",
    "debian-12": "libicu72",
    "debian-13": "libicu76",
  };
  const icuPackage = icuPackages[`${platform.distribution}-${platform.release}`];
  if (!icuPackage) {
    throw new Error("Unsupported platform for native ICU dependencies");
  }
  packages.push(icuPackage);
  if (building) {
    packages.push("build-essential", "perl");
  }
  return `set -eu\nexport DEBIAN_FRONTEND=noninteractive\napt-get update\napt-get install -y --no-install-recommends ${packages.join(" ")}\n`;
}

function downloadCommands(download: PinnedDownload, destination: string): string[] {
  const checksumLength = download.algorithm === "sha256" ? 64 : 128;
  if (!new RegExp(`^[a-f0-9]{${checksumLength}}$`).test(download.checksum)) {
    throw new Error(`Invalid pinned ${download.algorithm} checksum: ${download.url}`);
  }
  return [
    `curl --fail --location --retry 3 ${shellQuote(download.url)} --output ${shellQuote(destination)}`,
    `printf '%s  %s\\n' ${shellQuote(download.checksum)} ${shellQuote(destination)} | ${download.algorithm}sum --check -`,
  ];
}

function launcherCommands(
  path: string,
  arguments_: string[],
  environment: Record<string, string> = {},
  fallbackToolPath?: string,
): string[] {
  const assignments = Object.entries(environment).map(
    ([name, value]) => `${name}=${shellQuote(value)}`,
  );
  const fallbackPath = fallbackToolPath
    ? `export PATH="$PATH":${shellQuote(fallbackToolPath)}\n`
    : "";
  const script = `#!/bin/sh\n${fallbackPath}exec env ${[...assignments, ...arguments_.map(shellQuote)].join(" ")} "$@"\n`;
  return [
    `mkdir -p ${shellQuote(path.slice(0, path.lastIndexOf("/")))}`,
    `printf '%s' ${shellQuote(script)} > ${shellQuote(path)}`,
    `chmod 755 ${shellQuote(path)}`,
  ];
}

function npmInstallCommands(name: string, directory: string): string[] {
  const artifact = npmArtifacts[name];
  const checksum = Buffer.from(artifact.integrity, "base64").toString("hex");
  return [
    ...downloadCommands(
      {
        url: `https://registry.npmjs.org/${name}/-/${name}-${artifact.version}.tgz`,
        algorithm: "sha512",
        checksum,
      },
      "/tmp/package.tgz",
    ),
    `mkdir -p ${shellQuote(directory)}`,
    `tar -xzf /tmp/package.tgz --strip-components=1 -C ${shellQuote(directory)}`,
  ];
}

function runtimeInstallCommands(tool: CatalogTool, platform: ToolPlatform): string[] {
  const prefix = catalogToolPrefix(tool);
  const commands = [
    ...downloadCommands(toolRuntimeDownload(tool.id, platform), "/tmp/runtime.tar"),
    `mkdir -p ${shellQuote(prefix)} /tmp/runtime-source`,
  ];
  if (tool.id === "dotnet-runtime") {
    return [...commands, `tar -xzf /tmp/runtime.tar -C ${shellQuote(prefix)}`];
  }
  if (tool.id === "node-runtime" && platform.libc === "musl") {
    return [
      ...commands,
      "tar -xJf /tmp/runtime.tar --strip-components=1 -C /tmp/runtime-source",
      "cd /tmp/runtime-source",
      `./configure --prefix=${shellQuote(prefix)}`,
      "make -j2",
      "make install",
    ];
  }
  if (tool.id === "rust-runtime" || tool.id === "rust-analyzer") {
    const installRustToolchainComponents = tool.id === "rust-runtime";
    const componentOption = installRustToolchainComponents
      ? ` --components=rustc,cargo,rust-std-${rustDistributionTarget(platform)}`
      : "";
    const installCommands = [
      ...commands,
      "tar -xJf /tmp/runtime.tar --strip-components=1 -C /tmp/runtime-source",
      "cd /tmp/runtime-source",
      `sh install.sh --prefix=${shellQuote(prefix)} --disable-ldconfig${componentOption}`,
    ];
    if (installRustToolchainComponents) {
      installCommands.push(
        ...downloadCommands(
          {
            url: "https://static.rust-lang.org/dist/2026-09-03/rust-src-1.98.1.tar.xz",
            algorithm: "sha256",
            checksum: "5c846ebcebcc7e2e0777a4cdaa12051691593f16a7e94edbae5e6241cc62d98c",
          },
          "/tmp/rust-src.tar.xz",
        ),
        "mkdir /tmp/rust-source-component",
        "tar -xJf /tmp/rust-src.tar.xz --strip-components=1 -C /tmp/rust-source-component",
        `sh /tmp/rust-source-component/install.sh --prefix=${shellQuote(prefix)} --disable-ldconfig`,
      );
    }
    return installCommands;
  }
  const compression = tool.id === "go-runtime" ? "z" : "J";
  return [
    ...commands,
    `tar -x${compression}f /tmp/runtime.tar --strip-components=1 -C ${shellQuote(prefix)}`,
  ];
}

function serverInstallCommands(tool: CatalogTool, platform: ToolPlatform): string[] {
  const prefix = catalogToolPrefix(tool);
  if (tool.id === "typescript" || tool.id === "pyright") {
    const packageName = tool.id === "typescript" ? "typescript-language-server" : "pyright";
    const packageDirectory = `${prefix}/node_modules/${packageName}`;
    const node = catalogTool("node-runtime", "24.21.0").executable;
    return [
      ...npmInstallCommands(packageName, packageDirectory),
      ...(tool.id === "typescript"
        ? npmInstallCommands("typescript", `${prefix}/node_modules/typescript`)
        : []),
      ...launcherCommands(tool.executable, [
        node,
        `${packageDirectory}/${npmArtifacts[packageName].main}`,
      ]),
    ];
  }
  if (tool.id === "roslyn") {
    const rid = dotnetRuntimeIdentifier(platform);
    const packageName = `roslyn-language-server.${rid}`;
    const dotnet = catalogTool("dotnet-runtime", "10.0.102");
    const nativeServer = `${prefix}/Microsoft.CodeAnalysis.LanguageServer`;
    return [
      ...downloadCommands(
        {
          url: `https://api.nuget.org/v3-flatcontainer/${packageName}/${tool.version}/${packageName}.${tool.version}.nupkg`,
          algorithm: "sha256",
          checksum: roslynChecksums[rid],
        },
        "/tmp/roslyn.zip",
      ),
      "unzip -q /tmp/roslyn.zip -d /tmp/roslyn-package",
      `mkdir -p ${shellQuote(prefix)}`,
      `cp -a /tmp/roslyn-package/tools/net10.0/${rid}/. ${shellQuote(`${prefix}/`)}`,
      `chmod 755 ${shellQuote(nativeServer)}`,
      ...launcherCommands(
        tool.executable,
        [dotnet.executable, `${prefix}/roslyn-language-server.dll`],
        {
          DOTNET_ROOT: catalogToolPrefix(dotnet),
          DOTNET_CLI_TELEMETRY_OPTOUT: "1",
        },
        catalogToolPrefix(dotnet),
      ),
    ];
  }
  if (tool.id === "gopls") {
    const go = catalogTool("go-runtime", "1.27.1");
    return [
      `mkdir -p ${shellQuote(`${prefix}/libexec`)}`,
      `env CGO_ENABLED=0 GOTOOLCHAIN=local GOBIN=${shellQuote(`${prefix}/libexec`)} ${shellQuote(go.executable)} install ${shellQuote(tool.distributionPackages[0])}`,
      ...launcherCommands(
        tool.executable,
        [`${prefix}/libexec/gopls`],
        {},
        `${catalogToolPrefix(go)}/bin`,
      ),
    ];
  }
  const rust = catalogTool("rust-runtime", "1.98.1");
  return [
    ...runtimeInstallCommands(tool, platform),
    `mkdir -p ${shellQuote(`${prefix}/libexec`)}`,
    `mv ${shellQuote(tool.executable)} ${shellQuote(`${prefix}/libexec/rust-analyzer`)}`,
    ...launcherCommands(
      tool.executable,
      [`${prefix}/libexec/rust-analyzer`],
      {},
      `${catalogToolPrefix(rust)}/bin`,
    ),
  ];
}

export function toolArtifactRecipe(options: {
  tool: CatalogTool;
  platform: ToolPlatform;
  builderImageId: string;
  dependencies: readonly ToolArtifactImage[];
}): GeneratedImageRecipe {
  const tool = catalogTool(options.tool.id, options.tool.version);
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(options.builderImageId)) {
    throw new Error("Tool artifact builder must be an immutable image ID");
  }
  const dependencies = options.dependencies.map((dependency, index) => {
    if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(dependency.imageId)) {
      throw new Error("Tool dependency must be an immutable image ID");
    }
    const prefix = catalogToolPrefix(dependency.tool);
    return {
      from: `FROM ${dependency.imageId} AS dependency_${index}`,
      copy: `COPY --from=dependency_${index} ${prefix}/ ${prefix}/`,
    };
  });
  const commands =
    tool.role === "runtime"
      ? runtimeInstallCommands(tool, options.platform)
      : serverInstallCommands(tool, options.platform);
  const prefix = catalogToolPrefix(tool);
  return {
    containerfile: [
      ...dependencies.map((dependency) => dependency.from),
      `FROM ${options.builderImageId} AS build`,
      "USER root",
      'COPY ["native-dependencies.sh", "/tmp/pi-builder-dependencies.sh"]',
      'RUN ["sh", "/tmp/pi-builder-dependencies.sh"]',
      ...dependencies.map((dependency) => dependency.copy),
      'COPY ["install.sh", "/tmp/pi-install.sh"]',
      'RUN ["sh", "/tmp/pi-install.sh"]',
      "FROM scratch AS artifact",
      `COPY --from=build ${prefix}/ ${prefix}/`,
      "",
    ].join("\n"),
    files: {
      "native-dependencies.sh": nativeToolDependencies(options.platform, true),
      "install.sh": `set -eu\n${commands.join("\n")}\n`,
    },
  };
}
