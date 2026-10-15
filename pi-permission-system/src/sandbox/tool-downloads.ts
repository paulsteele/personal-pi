import {
  dotnetRuntimeIdentifier,
  rustDistributionTarget,
  type ToolPlatform,
} from "./tool-platform.ts";

export interface PinnedDownload {
  url: string;
  algorithm: "sha256" | "sha512";
  checksum: string;
}

const nodeChecksums = {
  amd64: "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6",
  arm64: "6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2",
};
const goChecksums = {
  amd64: "63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445",
  arm64: "3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec",
};
const dotnetChecksums: Record<string, string> = {
  "linux-arm64":
    "1254141153d29b5b926e0e7b0b172a25f9c096b8ed6a182f54062c5e0b41384b30e10e2bf1ebe86ed0f58f4ff762203acd83bcf23fefb59c07af45332d794700",
  "linux-musl-arm64":
    "10be1f3f2516fbc1049ad8fcb00bd12bbb16a2d20f708b6cd0177cd8775d01e9dec10ec1fbe4b570d7c82b158cb745d77e8ec66ff0b9f56327778562ba1a77be",
  "linux-musl-x64":
    "3586eb8de224d7585bf6cfd20f489e27c0a2a1fc8cb107c7ee2a07bead48b1edb0241f52febcf0e2f9f5fdf3ece3cf2e2f988b149166947445189e7406652ccd",
  "linux-x64":
    "7adf40e8e5547970391cfbe474c3874c6918ce3575ac398f376c78502134e1c8a2fa3da9aca281fdaeda81671f56c851ebe9e74c5b57c5a298bd45deba63565d",
};
const rustChecksums: Record<string, { runtime: string; analyzer: string }> = {
  "x86_64-unknown-linux-gnu": {
    runtime: "5326b36c53de11d148c8f8dab6553a3d1006c2cfd32123683073fad3c302605b",
    analyzer: "19beefa939b986be0086a36a24c540801ce849ee74f39ee933b60f947b0d4431",
  },
  "aarch64-unknown-linux-gnu": {
    runtime: "0b514a8cc1cbcd939bff0f151661fe58b6ea5c7a7f645a5098c69e32e8c1e0a2",
    analyzer: "a0fd960a9ab36193ae9ba4310e5f780f6ca38fa86160fae739be4ac541b6d10c",
  },
  "x86_64-unknown-linux-musl": {
    runtime: "2ada47301c1b232e1d98d59bd11df13274ba76ddd07336b90464010cf4644628",
    analyzer: "b1c550c79fa91493d59665074d368f2b8f2583db798f7a98683e70d5bf38422d",
  },
  "aarch64-unknown-linux-musl": {
    runtime: "c1dc0f3d12f97a0139ee91010f98002d66927baa210428ea8c68aadcd69bada4",
    analyzer: "84dc0cc504b410af83f6e6347c57759b5a7bba4907cf2de2ca84df11332d930d",
  },
};

const jscpdChecksums: Record<string, string> = {
  "arm64-gnu": "6f8ddab0aec0232d08a6aa0c36cddb435ddde2c24a447cc9afe603ac8556748c",
  "arm64-musl": "9a89b6c6a62d798759d2e94142e22bfcfdb6962dfca9b12b890a92d541c4069e",
  "x64-gnu": "f2017a17de2a8d5708f8354c6e7223f82da3dc6489675bce543ba00d9d529468",
  "x64-musl": "226149bbf3e48df408005dd3222d5c42367f7cfef4c5788e4da9f4f6a5003b63",
};

export function jscpdDownload(platform: ToolPlatform): PinnedDownload {
  const architecture = platform.architecture === "amd64" ? "x64" : "arm64";
  const target = `${architecture}-${platform.libc === "musl" ? "musl" : "gnu"}`;
  return {
    url: `https://github.com/kucherenko/jscpd/releases/download/v5.4.1/jscpd-linux-${target}.tar.gz`,
    algorithm: "sha256",
    checksum: jscpdChecksums[target],
  };
}

export function toolRuntimeDownload(id: string, platform: ToolPlatform): PinnedDownload {
  if (id === "node-runtime") {
    const architecture = platform.architecture === "amd64" ? "x64" : "arm64";
    const archive =
      platform.libc === "musl"
        ? "node-v24.21.0.tar.xz"
        : `node-v24.21.0-linux-${architecture}.tar.xz`;
    return {
      url: `https://nodejs.org/download/release/v24.21.0/${archive}`,
      algorithm: "sha256",
      checksum:
        platform.libc === "musl"
          ? "a6f54defb6fd7c84f41dba13d61e78e9b4e0961712cf61f29715c05f5ced94fc"
          : nodeChecksums[platform.architecture],
    };
  }
  if (id === "go-runtime") {
    return {
      url: `https://go.dev/dl/go1.27.1.linux-${platform.architecture}.tar.gz`,
      algorithm: "sha256",
      checksum: goChecksums[platform.architecture],
    };
  }
  if (id === "dotnet-runtime") {
    const rid = dotnetRuntimeIdentifier(platform);
    return {
      url: `https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.102/dotnet-sdk-10.0.102-${rid}.tar.gz`,
      algorithm: "sha512",
      checksum: dotnetChecksums[rid],
    };
  }
  if (id === "rust-runtime" || id === "rust-analyzer") {
    const target = rustDistributionTarget(platform);
    const isRustRuntime = id === "rust-runtime";
    const component = isRustRuntime ? "rust" : "rust-analyzer";
    const checksumComponent = isRustRuntime ? "runtime" : "analyzer";
    return {
      url: `https://static.rust-lang.org/dist/2026-09-03/${component}-1.98.1-${target}.tar.xz`,
      algorithm: "sha256",
      checksum: rustChecksums[target][checksumComponent],
    };
  }
  throw new Error(`No pinned runtime download for ${id}`);
}
