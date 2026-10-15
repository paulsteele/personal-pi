export interface CatalogTool {
  id: string;
  version: string;
  role: "runtime" | "language-server" | "quality-tool";
  dependencies: readonly string[];
  executable: string;
  distributionPackages: readonly string[];
}

export const STANDARD_TOOL_CATALOG: readonly CatalogTool[] = [
  {
    id: "jscpd",
    version: "5.4.1",
    role: "quality-tool",
    dependencies: [],
    executable: "/opt/pi-tools/jscpd/5.4.1/bin/jscpd",
    distributionPackages: [],
  },
  {
    id: "node-runtime",
    version: "24.21.0",
    role: "runtime",
    dependencies: [],
    executable: "/opt/pi-tools/node-runtime/24.21.0/bin/node",
    distributionPackages: [],
  },
  {
    id: "dotnet-runtime",
    version: "10.0.102",
    role: "runtime",
    dependencies: [],
    executable: "/opt/pi-tools/dotnet-runtime/10.0.102/dotnet",
    distributionPackages: [],
  },
  {
    id: "go-runtime",
    version: "1.27.1",
    role: "runtime",
    dependencies: [],
    executable: "/opt/pi-tools/go-runtime/1.27.1/bin/go",
    distributionPackages: [],
  },
  {
    id: "rust-runtime",
    version: "1.98.1",
    role: "runtime",
    dependencies: [],
    executable: "/opt/pi-tools/rust-runtime/1.98.1/bin/rustc",
    distributionPackages: [],
  },
  {
    id: "typescript",
    version: "6.0.1",
    role: "language-server",
    dependencies: ["node-runtime"],
    executable: "/opt/pi-tools/typescript/6.0.1/bin/typescript-language-server",
    distributionPackages: ["typescript-language-server@6.0.1", "typescript@5.9.3"],
  },
  {
    id: "pyright",
    version: "1.1.414",
    role: "language-server",
    dependencies: ["node-runtime"],
    executable: "/opt/pi-tools/pyright/1.1.414/bin/pyright-langserver",
    distributionPackages: ["pyright@1.1.414"],
  },
  {
    id: "roslyn",
    version: "5.12.0-1.26426.8",
    role: "language-server",
    dependencies: ["dotnet-runtime"],
    executable: "/opt/pi-tools/roslyn/5.12.0-1.26426.8/bin/roslyn-language-server",
    distributionPackages: ["roslyn-language-server"],
  },
  {
    id: "gopls",
    version: "0.23.0",
    role: "language-server",
    dependencies: ["go-runtime"],
    executable: "/opt/pi-tools/gopls/0.23.0/bin/gopls",
    distributionPackages: ["golang.org/x/tools/gopls@v0.23.0"],
  },
  {
    id: "rust-analyzer",
    version: "1.98.1",
    role: "language-server",
    dependencies: ["rust-runtime"],
    executable: "/opt/pi-tools/rust-analyzer/1.98.1/bin/rust-analyzer",
    distributionPackages: ["rust-analyzer-preview"],
  },
];

export const REQUIRED_LANGUAGE_SERVERS = STANDARD_TOOL_CATALOG.filter(
  (tool) => tool.role === "language-server",
).map((tool) => tool.id);

export function catalogTool(
  id: string,
  version: string,
  catalog: readonly CatalogTool[] = STANDARD_TOOL_CATALOG,
): CatalogTool {
  const tool = catalog.find((entry) => entry.id === id && entry.version === version);
  if (!tool) {
    throw new Error(`No verified tooling recipe for ${id}@${version}`);
  }
  return tool;
}

export function managedCatalogTool(
  id: string,
  requestedVersion: string,
  catalog: readonly CatalogTool[] = STANDARD_TOOL_CATALOG,
): CatalogTool | undefined {
  const managedVersions = catalog.filter((tool) => tool.id === id).map((tool) => tool.version);
  if (!managedVersions.length) {
    return undefined;
  }
  const version = requestedVersion.replace(/^v/, "");
  if (!managedVersions.includes(version)) {
    throw new Error(
      `${id} is a managed tool; request a verified catalog version: ${managedVersions.join(", ")}`,
    );
  }
  return catalogTool(id, version, catalog);
}

export function catalogToolPrefix(tool: Pick<CatalogTool, "id" | "version">): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(tool.id) || !/^[a-zA-Z0-9_.-]+$/.test(tool.version)) {
    throw new Error("Invalid catalog tool installation identity");
  }
  return `/opt/pi-tools/${tool.id}/${tool.version}`;
}
