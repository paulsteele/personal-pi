import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  applyProjectEnvironment,
  orderedLifecycleRunner,
  parseProjectEnvironment,
} from "../src/sandbox/project-environment.ts";
import { equippedBaseRecipe, projectImageRecipe } from "../src/sandbox/tool-assembly.ts";
import { STANDARD_TOOL_CATALOG } from "../src/sandbox/tool-catalog.ts";

it("extends runtime settings without changing the selected base", () => {
  const base = {
    image: "node:24-bookworm",
    remoteUser: "node",
    containerEnv: { SHARED: "base", BASE: "kept" },
    remoteEnv: { PATH: "/app/bin" },
  };
  const supplement = parseProjectEnvironment({
    version: 1,
    containerEnv: { SHARED: "project" },
    remoteEnv: { PROJECT: "yes" },
  });
  expect(applyProjectEnvironment(base, supplement)).toEqual({
    ...base,
    containerEnv: { SHARED: "project", BASE: "kept" },
    remoteEnv: { PATH: "/app/bin", PROJECT: "yes" },
  });
  expect(base.containerEnv.SHARED).toBe("base");
});

it("preserves an argv lifecycle command when no base command exists", () => {
  const effective = applyProjectEnvironment(
    { image: "node" },
    parseProjectEnvironment({
      version: 1,
      postCreateCommand: ["npm", "ci"],
    }),
  );
  expect(effective.postCreateCommand).toEqual(["npm", "ci"]);
});

it("waits for all base lifecycle commands before executing the private addition", async () => {
  const base = {
    image: "node",
    postCreateCommand: { first: ["printf", "first\n"], second: ["printf", "second\n"] },
  };
  const supplement = parseProjectEnvironment({
    version: 1,
    postCreateCommand: ["printf", "addition\n"],
  });
  const command = applyProjectEnvironment(base, supplement).postCreateCommand as string[];
  expect(command.slice(0, 3)).toEqual(["python3", "-c", orderedLifecycleRunner]);
  const result = await promisify(execFile)(command[0], command.slice(1));
  expect(result.stdout.trim().split("\n").slice(0, 2).sort()).toEqual(["first", "second"]);
  expect(result.stdout.trim().split("\n").at(-1)).toBe("addition");
});

it("does not run a private lifecycle addition after a base failure", async () => {
  const effective = applyProjectEnvironment(
    { image: "node", postCreateCommand: ["sh", "-c", "exit 7"] },
    parseProjectEnvironment({
      version: 1,
      postCreateCommand: ["printf", "must-not-run"],
    }),
  );
  const command = effective.postCreateCommand as string[];
  await expect(promisify(execFile)(command[0], command.slice(1))).rejects.toMatchObject({
    code: 7,
    stdout: "",
  });
});

it.each(["../outside", "/absolute", "nested/../outside", "nested\\file", "nested//file"])(
  "rejects escaping or ambiguous companion path %s",
  (path) => {
    expect(() => parseProjectEnvironment({ version: 1, files: { [path]: "data" } })).toThrow(
      "relative project companion path",
    );
  },
);

it("does not allow project supplements to grant mounts or host initialization", () => {
  expect(() => parseProjectEnvironment({ version: 1, mounts: ["/host"] })).toThrow();
  expect(() =>
    parseProjectEnvironment({ version: 1, initializeCommand: "host-command" }),
  ).toThrow();
});

it("assembles separate linked component copies without project inputs", () => {
  const tools = STANDARD_TOOL_CATALOG.filter((tool) =>
    ["node-runtime", "pyright"].includes(tool.id),
  );
  const artifacts = tools.map((tool, index) => ({
    tool,
    imageId: `sha256:${String(index + 1).repeat(64)}`,
  }));
  const recipe = equippedBaseRecipe({
    baseImageId: `sha256:${"a".repeat(64)}`,
    imageUser: "1000:1000",
    artifacts,
    nativeDependenciesScript: "set -eu\ninstall-libraries\n",
    copyMode: "linked",
  });
  expect(recipe.containerfile).toContain(
    "COPY --link --from=tool_node_runtime /opt/pi-tools/node-runtime/24.21.0/",
  );
  expect(recipe.containerfile).toContain(
    "COPY --link --from=tool_pyright /opt/pi-tools/pyright/1.1.414/",
  );
  expect(recipe.containerfile).toMatch(/USER 1000:1000\n$/);
  expect(recipe.containerfile).not.toContain("project-install");
});

it("uses ordinary copies when the backend has no linked-copy capability", () => {
  const recipe = equippedBaseRecipe({
    baseImageId: `sha256:${"a".repeat(64)}`,
    imageUser: "root",
    artifacts: [{ tool: STANDARD_TOOL_CATALOG[0], imageId: `sha256:${"b".repeat(64)}` }],
    nativeDependenciesScript: "true\n",
    copyMode: "ordinary",
  });
  expect(recipe.containerfile).toContain("COPY --from=tool_node_runtime");
  expect(recipe.containerfile).not.toContain("--link");
});

it("places private install recipes after the immutable equipped base", () => {
  const recipe = projectImageRecipe({
    equippedImageId: `sha256:${"c".repeat(64)}`,
    imageUser: "node",
    companionFiles: { "install.sh": "install-sdk\n" },
    installations: [
      {
        id: "sdk",
        version: "1.0",
        executable: "/opt/sdk/bin/sdk",
        prerequisites: [],
        environment: {},
        command: ["sh", "/opt/pi-project-setup/install.sh"],
      },
    ],
  });
  expect(recipe.containerfile).toContain(`FROM sha256:${"c".repeat(64)} AS project`);
  expect(recipe.containerfile).toContain("/opt/pi-project-setup/install.sh");
  expect(recipe.files).toEqual({ "project-files/install.sh": "install-sdk\n" });
  expect(recipe.containerfile).toMatch(/USER node\n$/);
});
