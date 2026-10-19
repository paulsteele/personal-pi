import { expect, it } from "vitest";
import { declaredBindMount, declaredMount } from "../src/sandbox/declaration-mounts.ts";

const base = "/projects/app/.devcontainer";

it("resolves a bind string relative to the definition directory", () => {
  expect(declaredMount("type=bind,source=../cache,target=/cache,readonly", base)).toEqual({
    kind: "bind",
    path: "/projects/app/cache",
    destination: "/cache",
    access: "ro",
  });
});

it("accepts a bind object declaration", () => {
  expect(
    declaredMount({ type: "bind", source: "/data", target: "/data", readOnly: false }, base),
  ).toEqual({ kind: "bind", path: "/data", destination: "/data", access: "rw" });
});

it("recognizes a named volume string and ignores its declared source", () => {
  expect(
    declaredMount(
      "source=sep-defaults-${devcontainerId}-node-modules,target=/workspaces/defaults/node_modules,type=volume",
      base,
    ),
  ).toEqual({ kind: "volume", destination: "/workspaces/defaults/node_modules", access: "rw" });
});

it("recognizes a read-only volume object declaration", () => {
  expect(
    declaredMount({ type: "volume", source: "shared", target: "/shared", readOnly: true }, base),
  ).toEqual({ kind: "volume", destination: "/shared", access: "ro" });
});

it("rejects tmpfs declarations and names the offending mount", () => {
  expect(() => declaredMount("type=tmpfs,target=/scratch", base)).toThrow(
    "Mount declarations must be binds with an explicit source or named volumes: type=tmpfs,target=/scratch",
  );
});

it("rejects a bind without a source", () => {
  expect(() => declaredMount("type=bind,target=/data", base)).toThrow(
    "must be binds with an explicit source",
  );
});

it("rejects a declaration without a target", () => {
  expect(() => declaredMount("type=volume,source=cache", base)).toThrow(
    "Mount declaration requires a target: type=volume,source=cache",
  );
});

it("rejects a volume where only a bind is acceptable", () => {
  expect(() => declaredBindMount("type=volume,target=/cache", base)).toThrow(
    "Expected a bind mount declaration: type=volume,target=/cache",
  );
});
