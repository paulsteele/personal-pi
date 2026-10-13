import { z } from "zod";
import type { MountGrant } from "./mounts.ts";
import {
  consumeInspectedToolImageMounts,
  inspectedToolMountSchema,
  type ToolImageMount,
} from "./tool-image-mounts.ts";

export const containerDetailsSchema = z.looseObject({
  Id: z.string().min(1),
  Image: z.string().min(1),
  StaticDir: z.string().optional(),
  State: z.looseObject({ Running: z.boolean() }),
  Config: z.looseObject({ Labels: z.record(z.string(), z.string()).nullable() }),
  HostConfig: z.looseObject({
    Privileged: z.boolean(),
    NetworkMode: z.string(),
    PidMode: z.string(),
    SecurityOpt: z.array(z.string()),
    Devices: z.array(z.unknown()).nullable(),
  }),
  EffectiveCaps: z.array(z.string()).nullable().optional(),
  Mounts: z.array(inspectedToolMountSchema),
});

export function validateCreatedContainer(
  value: unknown,
  sessionId: string,
  mounts: readonly MountGrant[],
  toolImageMounts: readonly ToolImageMount[] = [],
): string {
  const container = containerDetailsSchema.parse(value);
  const belongsToSession = container.Config.Labels?.["pi.sandbox.session"] === sessionId;
  const isolatesProcesses = container.HostConfig.PidMode !== "host";
  const isolatesNetwork = container.HostConfig.NetworkMode !== "host";
  const preventsPrivilegeEscalation =
    container.HostConfig.SecurityOpt.includes("no-new-privileges");
  const hasUnexpectedPrivileges =
    container.HostConfig.Privileged ||
    (container.EffectiveCaps?.length ?? 0) > 0 ||
    (container.HostConfig.Devices?.length ?? 0) > 0;
  const meetsSessionIsolationPolicy =
    belongsToSession &&
    container.State.Running &&
    isolatesProcesses &&
    isolatesNetwork &&
    preventsPrivilegeEscalation &&
    !hasUnexpectedPrivileges;
  if (!meetsSessionIsolationPolicy) {
    throw new Error("Created container does not meet the approved session isolation policy");
  }
  const inspectedMounts = {
    mounts: container.Mounts,
    expected: toolImageMounts,
    containerId: container.Id,
    staticDir: container.StaticDir,
  };
  const hostMounts = consumeInspectedToolImageMounts(inspectedMounts);
  if (hostMounts.length !== mounts.length) {
    throw new Error("Created container has an unexpected mount count");
  }
  const seenDestinations = new Set<string>();
  for (const mounted of hostMounts) {
    const approved = mounts.find(
      (grant) => grant.source === mounted.Source && grant.destination === mounted.Destination,
    );
    const matchesApprovedGrant =
      approved !== undefined &&
      mounted.Type === "bind" &&
      mounted.RW === (approved.access === "rw");
    const isDuplicateDestination = seenDestinations.has(mounted.Destination);
    if (!matchesApprovedGrant || isDuplicateDestination) {
      throw new Error(`Created container has an unapproved mount: ${mounted.Destination}`);
    }
    seenDestinations.add(mounted.Destination);
  }
  return container.Id;
}
