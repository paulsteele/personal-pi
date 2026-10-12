import { z } from "zod";
import type { DevcontainerDefinition } from "./definition.ts";

export const imageDetailsSchema = z.looseObject({
  Id: z.string().min(1),
  Config: z.looseObject({
    User: z.string().optional(),
    Env: z.array(z.string()).optional(),
    Labels: z.record(z.string(), z.string()).nullable().optional(),
    Volumes: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
});
export type ImageDetails = z.output<typeof imageDetailsSchema>;

export function validateImageIsolation(
  image: ImageDetails,
  approvedMountArguments: readonly string[] = [],
): void {
  if (Object.keys(image.Config.Volumes ?? {}).length) {
    throw new Error(
      "Image-declared anonymous volumes are unsupported; declare approved devcontainer mounts",
    );
  }
  const encoded = image.Config.Labels?.["devcontainer.metadata"];
  if (!encoded) {
    return;
  }
  const decoded: unknown = JSON.parse(encoded);
  const entries = Array.isArray(decoded) ? decoded : [decoded];
  for (const value of entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid devcontainer image metadata");
    }
    const entry = value as Record<string, unknown>;
    const requestsUnsupportedPrivilegesOrOrchestration =
      entry.privileged ||
      entry.capAdd ||
      entry.securityOpt ||
      entry.features ||
      entry.dockerComposeFile;
    if (requestsUnsupportedPrivilegesOrOrchestration) {
      throw new Error(
        "Devcontainer image metadata requests unsupported privileges or orchestration",
      );
    }
    if (entry.mounts !== undefined && !Array.isArray(entry.mounts)) {
      throw new Error("Invalid image metadata mount declaration");
    }
    const declaresUnapprovedMounts =
      Array.isArray(entry.mounts) &&
      entry.mounts.some(
        (mount) => typeof mount !== "string" || !approvedMountArguments.includes(mount),
      );
    if (declaresUnapprovedMounts) {
      throw new Error(
        "Image metadata declares host mounts; approve them in the devcontainer definition first",
      );
    }
  }
}

export function validateResolvedMetadata(
  effective: Record<string, unknown>,
  definition: DevcontainerDefinition,
): void {
  const weakensMandatoryIsolation =
    effective.privileged ||
    effective.capAdd ||
    effective.securityOpt ||
    effective.features ||
    effective.dockerComposeFile;
  if (weakensMandatoryIsolation) {
    throw new Error("Resolved devcontainer metadata weakens mandatory isolation");
  }
  const effectiveMounts = effective.mounts ?? [];
  if (JSON.stringify(effectiveMounts) !== JSON.stringify(definition.mounts ?? [])) {
    throw new Error("Image metadata changed the approved mount set");
  }
  const effectiveEnvironment = effective.containerEnv ?? {};
  if (JSON.stringify(effectiveEnvironment) !== JSON.stringify(definition.containerEnv ?? {})) {
    throw new Error("Image metadata changed the approved container environment");
  }
}
