import { expect, it, vi } from "vitest";
import { catalogTool } from "../src/sandbox/tool-catalog.ts";
import {
  toolImageMount,
  toolImageMountArgument,
  toolImageMountSchema,
  toolImageMountsSchema,
  validateToolImageInventory,
  verifyToolMountDestinations,
} from "../src/sandbox/tool-image-mounts.ts";
import { validateMountDestination, guestToHost } from "../src/sandbox/mounts.ts";
import { sessionRecordSchema } from "../src/sandbox/session-record.ts";
import type { ToolInventory } from "../src/sandbox/tool-inventory.ts";

const node = catalogTool("node-runtime", "24.21.0");
const pyright = catalogTool("pyright", "1.1.414");
const mounts = [toolImageMount(node, "a".repeat(64)), toolImageMount(pyright, "b".repeat(64))];
const inventory: ToolInventory = {
  version: 1,
  revision: "c".repeat(64),
  platform: "linux-arm64-debian-12-glibc",
  tools: [node, pyright].map((tool, index) => ({
    id: tool.id,
    version: tool.version,
    executable: tool.executable,
    source: "global",
    imageId: mounts[index]!.imageId,
  })),
};

it("keeps exact versioned runtime paths and immutable read-only image arguments", () => {
  expect(toolImageMountArgument(mounts[0]!)).toBe(
    `type=image,source=${"a".repeat(64)},subpath=/opt/pi-tools/node-runtime/24.21.0,destination=/opt/pi-tools/node-runtime/24.21.0,rw=false`,
  );
  expect(() => validateToolImageInventory(mounts, inventory)).not.toThrow();
  expect(guestToHost(node.executable, [])).toBeUndefined();
});

it.each([
  { imageId: "node:latest" },
  { readOnly: false },
  { subpath: "/opt/pi-tools/../outside" },
  { destination: "/usr/bin" },
  { subpath: "/opt/pi-tools/node-runtime/24.21.0/" },
  { destination: "/opt/pi-tools/node-runtime/24.21.0,nonsense=true" },
])("rejects a noncanonical tool mount %j", (change) => {
  expect(() => toolImageMountSchema.parse({ ...mounts[0], ...change })).toThrow();
});

it("rejects duplicate tool identities and missing runtime dependency mounts", () => {
  expect(() => toolImageMountsSchema.parse([mounts[0], mounts[0]])).toThrow("Duplicate");
  expect(() => validateToolImageInventory([mounts[1]!], inventory)).toThrow("runtime dependency");
  expect(() => validateToolImageInventory([mounts[0]!], inventory)).toThrow("no image mount");
});

it("rejects artifact provenance that differs from the tool inventory", () => {
  const wrongImage = { ...mounts[0]!, imageId: "d".repeat(64) };
  expect(() => validateToolImageInventory([wrongImage, mounts[1]!], inventory)).toThrow(
    "differs from inventory",
  );
});

it.each([
  "/opt",
  "/opt/pi-tools",
  "/opt/pi-tools/node-runtime",
  "/opt/pi-tools/node-runtime/24.21.0",
])("reserves %s against host mount shadowing", (destination) => {
  expect(() => validateMountDestination(destination)).toThrow("protected");
  expect(() => validateMountDestination("/opt/project-sdk")).not.toThrow();
});

it("accepts records with omitted tool image mounts and records with an explicit mount list", () => {
  const record = {
    version: 1,
    sessionId: "session",
    startupDirectory: "/repo",
    definitionRevision: "revision",
    generation: 1,
    mounts: [],
    environment: {
      container: "container",
      image: "image",
      user: "root",
      workspace: "/repo",
      configuration: {},
      toolInventory: inventory,
    },
  };
  expect(sessionRecordSchema.parse(record).environment.toolImageMounts).toBeUndefined();
  expect(
    sessionRecordSchema.parse({
      ...record,
      environment: { ...record.environment, toolImageMounts: mounts },
    }).environment.toolImageMounts,
  ).toEqual(mounts);
  expect(
    sessionRecordSchema.parse({
      ...record,
      environment: { ...record.environment, toolImageMounts: [] },
    }).environment.toolImageMounts,
  ).toEqual([]);
});

it("checks destination ancestors and runs the image probe without mount arguments", async () => {
  const run = vi.fn(async (_args: string[], _signal?: AbortSignal) => "");
  await verifyToolMountDestinations({
    run,
    imageId: "e".repeat(64),
    containerName: "owned-probe",
    mounts,
  });
  const args = run.mock.calls[0]![0];
  expect(args).toContain("/opt");
  expect(args).toContain("/opt/pi-tools");
  expect(args).toContain("/opt/pi-tools/node-runtime/24.21.0");
  expect(args).not.toContain("--mount");
  expect(args.join(" ")).toContain('test -L "$path"');
  expect(run.mock.calls[1]![0]).toEqual(["rm", "--force", "--time=0", "--ignore", "owned-probe"]);
});
