import { type CatalogTool } from "./tool-catalog.ts";
import { installationInstruction, type ImageToolInstallation } from "./image-tool-recipe.ts";

export interface ToolArtifactImage {
  tool: CatalogTool;
  imageId: string;
}
export interface GeneratedImageRecipe {
  containerfile: string;
  files: Record<string, string>;
}

function imageReference(value: string): string {
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(value)) {
    throw new Error("Generated image recipes require an immutable local image ID");
  }
  return value;
}

function runtimeUser(value: string): string {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(value)) {
    throw new Error("Unsupported runtime user in generated tooling recipe");
  }
  return value;
}

export function infrastructureImageRecipe(options: {
  baseImageId: string;
  imageUser: string;
  nativeDependenciesScript: string;
}): GeneratedImageRecipe {
  const files = { "native-dependencies.sh": options.nativeDependenciesScript };
  const optDirectoryIsNotSymlink = "test ! -L /opt";
  const managedPrefixIsAbsent = "test ! -e /opt/pi-tools && test ! -L /opt/pi-tools";
  const validateManagedDestination = [optDirectoryIsNotSymlink, managedPrefixIsAbsent].join(" && ");
  return {
    containerfile: [
      `FROM ${imageReference(options.baseImageId)} AS infrastructure`,
      "USER root",
      `RUN ${JSON.stringify(["sh", "-c", validateManagedDestination])}`,
      'COPY ["native-dependencies.sh", "/tmp/pi-native-dependencies.sh"]',
      'RUN ["sh", "/tmp/pi-native-dependencies.sh"]',
      `USER ${runtimeUser(options.imageUser)}`,
      "",
    ].join("\n"),
    files,
  };
}

export function projectImageRecipe(options: {
  infrastructureImageId: string;
  imageUser: string;
  installations: readonly ImageToolInstallation[];
  companionFiles: Record<string, string>;
}): GeneratedImageRecipe {
  const copies: string[] = [];
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(options.companionFiles).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Invalid project build companion path: ${path}`);
    }
    const source = `project-files/${path}`;
    files[source] = content;
    copies.push(`COPY ${JSON.stringify([source, `/opt/pi-project-setup/${path}`])}`);
  }
  return {
    containerfile: [
      `FROM ${imageReference(options.infrastructureImageId)} AS project`,
      "USER root",
      ...copies,
      ...options.installations.map(installationInstruction),
      `USER ${runtimeUser(options.imageUser)}`,
      "",
    ].join("\n"),
    files,
  };
}
