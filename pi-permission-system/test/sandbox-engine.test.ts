import { expect, it } from "vitest";
import { authorizeEngineArguments, type EngineAuthority } from "../src/sandbox/engine-policy.ts";
import {
  guestToHost,
  hostToGuest,
  validateMountDestination,
  validateMountTopology,
} from "../src/sandbox/mounts.ts";

const authority: EngineAuthority = {
  label: "pi.sandbox.session=test",
  containerName: "pi-project-test-g1",
  containerLabels: { "pi.sandbox.project-root": "/repo" },
  containers: ["container-id"],
  images: ["sha256:image"],
  imageNames: ["debian:bookworm"],
  contexts: ["/repo"],
  containerfiles: ["/repo/Containerfile"],
  mounts: [
    {
      source: "/repo",
      destination: "/workspace",
      access: "rw",
      identity: "1:2",
      kind: "directory",
    },
  ],
  volumes: [],
  ports: [3000],
  environment: { NODE_ENV: "development" },
  users: ["root", "node"],
};

it("adds fixed isolation to a validated reference-CLI container invocation", () => {
  const args = authorizeEngineArguments(
    [
      "run",
      "--mount",
      "type=bind,source=/repo,target=/workspace,consistency=cached",
      "-e",
      "NODE_ENV=development",
      "--entrypoint",
      "/bin/sh",
      "debian:bookworm",
      "-c",
      "sleep infinity",
    ],
    "/repo",
    authority,
  );
  expect(args).toContain("--cap-drop=ALL");
  expect(args).toContain("--security-opt=no-new-privileges");
  expect(args).toContain("--network=bridge");
  expect(args).toContain("pi.sandbox.session=test");
  expect(args).toContain("pi-project-test-g1");
  expect(args).toContain("pi.sandbox.project-root=/repo");
});

it.each([
  ["run", "--privileged", "debian:bookworm"],
  ["run", "--network=host", "debian:bookworm"],
  ["run", "-v", "/:/host", "debian:bookworm"],
  ["run", "--mount", "type=bind,source=/home,target=/host", "debian:bookworm"],
  ["run", "-e", "TOKEN=secret", "debian:bookworm"],
  ["run", "-p", "0.0.0.0:3000:3000", "debian:bookworm"],
  ["run", "--security-opt=seccomp=unconfined", "debian:bookworm"],
  ["run", "other-image"],
  ["exec", "other-container", "bash"],
  ["system", "prune"],
  ["build", "--secret", "id=token", "/repo"],
  ["build", "-f", "/repo/Containerfile", "/other"],
])("blocks an unapproved engine operation %j", (...args) => {
  expect(() => authorizeEngineArguments(args, "/repo", authority)).toThrow();
});

it("allows only session-scoped inspection and execution", () => {
  expect(
    authorizeEngineArguments(
      ["exec", "-i", "-u", "node", "container-id", "bash", "-c", "pwd"],
      "/repo",
      authority,
    ),
  ).toEqual(["exec", "-i", "-u", "node", "container-id", "bash", "-c", "pwd"]);
  expect(authorizeEngineArguments(["inspect", "container-id"], "/repo", authority)).toEqual([
    "inspect",
    "container-id",
  ]);
});

it("maps guest and host paths without granting unmounted paths", () => {
  expect(hostToGuest("/repo/src/main.ts", authority.mounts)).toBe("/workspace/src/main.ts");
  expect(guestToHost("/workspace/src/main.ts", authority.mounts)).toBe("/repo/src/main.ts");
  expect(guestToHost("/workspace-other/main.ts", authority.mounts)).toBeUndefined();
  expect(hostToGuest("/other/main.ts", authority.mounts)).toBeUndefined();
});

it("rejects mounts that shadow guest system paths or an existing mapping", () => {
  expect(() => validateMountDestination("/etc")).toThrow("protected");
  expect(() => validateMountDestination("/workspace/../etc")).toThrow("normalized");
  expect(() =>
    validateMountTopology([
      ...authority.mounts,
      { ...authority.mounts[0], destination: "/workspace/nested" },
    ]),
  ).toThrow("Conflicting");
});
