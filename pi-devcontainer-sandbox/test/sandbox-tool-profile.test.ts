import { expect, it } from "vitest";
import { STANDARD_TOOL_CATALOG } from "../src/sandbox/tool-catalog.ts";
import {
  defaultToolProfile,
  parseToolProfile,
  parseUniqueJson,
  resolveToolProfiles,
  type ToolProfile,
} from "../src/sandbox/tool-profile.ts";
import {
  dotnetRuntimeIdentifier,
  resolveToolPlatform,
  rustDistributionTarget,
} from "../src/sandbox/tool-platform.ts";

const projectTool: ToolProfile["tools"][string] = {
  kind: "recipe",
  version: "1.0.0",
  command: ["installer", "--version", "1.0.0"],
  environment: {},
  executable: "/opt/project/bin/tool",
  prerequisites: [],
  dependencies: ["node-runtime"],
};

it("includes all five servers and orders their supporting runtimes first", () => {
  const tools = resolveToolProfiles(defaultToolProfile());
  expect(
    tools
      .filter((tool) => tool.catalog?.role === "language-server")
      .map((tool) => tool.id)
      .sort(),
  ).toEqual(["gopls", "pyright", "roslyn", "rust-analyzer", "typescript"]);
  expect(tools.findIndex((tool) => tool.id === "node-runtime")).toBeLessThan(
    tools.findIndex((tool) => tool.id === "pyright"),
  );
  expect(tools.findIndex((tool) => tool.id === "rust-runtime")).toBeLessThan(
    tools.findIndex((tool) => tool.id === "rust-analyzer"),
  );
});

it("applies a private catalog version without installing the global version twice", () => {
  const pyright = STANDARD_TOOL_CATALOG.find((tool) => tool.id === "pyright")!;
  const catalog = [...STANDARD_TOOL_CATALOG, { ...pyright, version: "1.1.415" }];
  const tools = resolveToolProfiles(
    defaultToolProfile(),
    {
      version: 1,
      tools: { pyright: { kind: "catalog", version: "1.1.415" } },
      exclude: [],
    },
    catalog,
  );
  expect(tools.filter((tool) => tool.id === "pyright")).toMatchObject([
    { source: "project", entry: { version: "1.1.415" } },
  ]);
});

it("keeps private installs separate from global tools", () => {
  const global = defaultToolProfile();
  const tools = resolveToolProfiles(global, {
    version: 1,
    tools: { private: projectTool },
    exclude: [],
  });
  expect(tools.find((tool) => tool.id === "private")?.source).toBe("project");
  expect(global.tools.private).toBeUndefined();
});

it("lets a project exclude optional global tools", () => {
  const global = defaultToolProfile();
  global.tools.shared = projectTool;
  const tools = resolveToolProfiles(global, {
    version: 1,
    tools: {},
    exclude: ["shared"],
  });
  expect(tools.some((tool) => tool.id === "shared")).toBe(false);
  expect(global.tools.shared).toBe(projectTool);
});

it("rejects a missing required language-server declaration", () => {
  const global = defaultToolProfile();
  delete global.tools.pyright;
  expect(() => resolveToolProfiles(global)).toThrow("must include language server: pyright");
});

it("rejects excluding a required language server", () => {
  expect(() => parseToolProfile({ version: 1, tools: {}, exclude: ["roslyn"] })).toThrow(
    "cannot be excluded",
  );
});

it("rejects excluding a runtime required by an installed server", () => {
  expect(() =>
    resolveToolProfiles(defaultToolProfile(), {
      version: 1,
      tools: {},
      exclude: ["node-runtime"],
    }),
  ).toThrow("Missing tool dependency: node-runtime");
});

it("rejects dependency cycles", () => {
  expect(() =>
    resolveToolProfiles(defaultToolProfile(), {
      version: 1,
      tools: {
        first: { ...projectTool, dependencies: ["second"] },
        second: { ...projectTool, dependencies: ["first"] },
      },
      exclude: [],
    }),
  ).toThrow("dependency cycle");
});

it("rejects custom recipes for managed servers", () => {
  expect(() =>
    resolveToolProfiles(defaultToolProfile(), {
      version: 1,
      tools: { roslyn: projectTool },
      exclude: [],
    }),
  ).toThrow("Managed tool requires a verified catalog recipe");
});

it("rejects duplicate JSON properties rather than silently overriding them", () => {
  expect(() => parseUniqueJson('{"tools":{"pyright":{},"pyright":{}}}')).toThrow(
    "Duplicate configuration property: pyright",
  );
  expect(() => parseUniqueJson('{"version":1,"version":2}')).toThrow(
    "Duplicate configuration property: version",
  );
  expect(parseUniqueJson('{"version":1}')).toEqual({ version: 1 });
});

it.each([
  ["amd64", "x64", "x86_64"],
  ["arm64", "arm64", "aarch64"],
])(
  "resolves Alpine artifacts for %s without selecting glibc binaries",
  (architecture, dotnetArch, rustArch) => {
    const platform = resolveToolPlatform({
      os: "linux",
      architecture,
      distribution: "alpine",
      release: "3.23.2",
      libc: "musl",
    });
    expect(platform.release).toBe("3.23");
    expect(dotnetRuntimeIdentifier(platform)).toBe(`linux-musl-${dotnetArch}`);
    expect(rustDistributionTarget(platform)).toBe(`${rustArch}-unknown-linux-musl`);
  },
);

it("rejects unsupported releases and a mismatched libc", () => {
  expect(() =>
    resolveToolPlatform({
      os: "linux",
      architecture: "amd64",
      distribution: "alpine",
      release: "3.20",
      libc: "musl",
    }),
  ).toThrow("Unsupported tooling platform");
  expect(() =>
    resolveToolPlatform({
      os: "linux",
      architecture: "arm64",
      distribution: "debian",
      release: "12",
      libc: "musl",
    }),
  ).toThrow("Unsupported tooling platform");
});
