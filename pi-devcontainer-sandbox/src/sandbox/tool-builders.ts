import { resolveToolPlatform, type ToolPlatform } from "./tool-platform.ts";

const builders: Record<string, { repository: string; amd64: string; arm64: string }> = {
  "debian-12": {
    repository: "docker.io/library/debian",
    amd64: "a4672c0cb26fbdde88e38fa2dfb6c681942306680e41e4378b28770b6e79ee91",
    arm64: "a1b86db52ce3daef089e45aabe36dfec4091f82464c25c1fdcf03de197cbe82a",
  },
  "debian-13": {
    repository: "docker.io/library/debian",
    amd64: "918311b7b6c4c6f68b232ba516584925f6c78ad82b6fd534b98979df6438e483",
    arm64: "a2ca65377c251208de42e1a2722cb949211236c161b634f6f3663754e2d06850",
  },
  "ubuntu-22.04": {
    repository: "docker.io/library/ubuntu",
    amd64: "08ea48a03a3e78ebc7cd526e6a275053223aadd88bfc09cc49b06d5281525fde",
    arm64: "30dfd7fe96f97c5f5ddf388ce8d098aa509644ad68fdef67244fb71b8169ffcb",
  },
  "ubuntu-24.04": {
    repository: "docker.io/library/ubuntu",
    amd64: "f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b",
    arm64: "08571ca13e00ca07a2a84eab83a959b4242e22cceb16486a11bef1428c9e93a7",
  },
  "alpine-3.21": {
    repository: "docker.io/library/alpine",
    amd64: "3c81aa9a3d770b316568f4499e30461a5cd3fbd7180bd89e28e34894c7845832",
    arm64: "0a7ed0d449b9318548e66674610d757de19b7645759f74b587b610b59d6b43fd",
  },
  "alpine-3.22": {
    repository: "docker.io/library/alpine",
    amd64: "3e9b4b680bfc9fb5269227cffbd6d42be39fbf7c0b908123913864aa4447e764",
    arm64: "2e1a7aa4cbc4e9e5222bb4c24a839aa1a6170ea5492d644777ce7b178824e44f",
  },
  "alpine-3.23": {
    repository: "docker.io/library/alpine",
    amd64: "1f3591b8a02ea153f41c5bba878ad477f63ab3d19349762cb77504db02a23e15",
    arm64: "ae959799024a09da597284763c417a6e820e020fad0634c5267cf4f125e682bf",
  },
};

export function toolBuilderReference(platform: ToolPlatform): string {
  const validated = resolveToolPlatform(platform);
  const builder = builders[`${validated.distribution}-${validated.release}`];
  const digest = builder[validated.architecture];
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Invalid pinned tooling builder digest");
  }
  return `${builder.repository}@sha256:${digest}`;
}
