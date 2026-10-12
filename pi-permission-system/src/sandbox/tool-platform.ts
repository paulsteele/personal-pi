import { z } from "zod";

export const toolPlatformSchema = z.strictObject({
  os: z.literal("linux"),
  architecture: z.enum(["amd64", "arm64"]),
  distribution: z.enum(["debian", "ubuntu", "alpine"]),
  release: z.string().regex(/^\d+(?:\.\d+)*$/),
  libc: z.enum(["glibc", "musl"]),
});

export type ToolPlatform = z.output<typeof toolPlatformSchema>;

const supportedReleases = {
  debian: ["12", "13"],
  ubuntu: ["22.04", "24.04"],
  alpine: ["3.21", "3.22", "3.23"],
} satisfies Record<ToolPlatform["distribution"], string[]>;

export function resolveToolPlatform(input: {
  os: string;
  architecture: string;
  distribution: string;
  release: string;
  libc: string;
}): ToolPlatform {
  const architecture =
    input.architecture === "x86_64" || input.architecture === "x64"
      ? "amd64"
      : input.architecture === "aarch64"
        ? "arm64"
        : input.architecture;
  const release =
    input.distribution === "alpine"
      ? input.release.split(".").slice(0, 2).join(".")
      : input.release;
  const platform = toolPlatformSchema.parse({ ...input, architecture, release });
  const expectedLibc = platform.distribution === "alpine" ? "musl" : "glibc";
  if (
    platform.libc !== expectedLibc ||
    !supportedReleases[platform.distribution].includes(platform.release)
  ) {
    throw new Error(
      `Unsupported tooling platform: ${platform.distribution} ${platform.release} ${platform.libc} ${platform.architecture}`,
    );
  }
  return platform;
}

export function toolPlatformKey(platform: ToolPlatform): string {
  const validated = resolveToolPlatform(platform);
  return [
    validated.os,
    validated.architecture,
    validated.distribution,
    validated.release,
    validated.libc,
  ].join("-");
}

export function rustDistributionTarget(platform: ToolPlatform): string {
  const validated = resolveToolPlatform(platform);
  const architecture = validated.architecture === "amd64" ? "x86_64" : "aarch64";
  const environment = validated.libc === "musl" ? "musl" : "gnu";
  return `${architecture}-unknown-linux-${environment}`;
}

export function dotnetRuntimeIdentifier(platform: ToolPlatform): string {
  const validated = resolveToolPlatform(platform);
  const architecture = validated.architecture === "amd64" ? "x64" : "arm64";
  const operatingSystem = validated.libc === "musl" ? "linux-musl" : "linux";
  return `${operatingSystem}-${architecture}`;
}
