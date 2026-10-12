import { z } from "zod";
import type { MountGrant } from "./mounts.ts";

export const containerDetailsSchema = z.looseObject({
  Id: z.string().min(1),
  Image: z.string().min(1),
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
  Mounts: z.array(
    z.looseObject({
      Type: z.string(),
      Source: z.string(),
      Destination: z.string(),
      RW: z.boolean(),
    }),
  ),
});

export function validateCreatedContainer(
  value: unknown,
  sessionId: string,
  mounts: readonly MountGrant[],
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
  if (container.Mounts.length !== mounts.length) {
    throw new Error("Created container has an unexpected mount count");
  }
  for (const mounted of container.Mounts) {
    const approved = mounts.find(
      (grant) => grant.source === mounted.Source && grant.destination === mounted.Destination,
    );
    if (!approved || mounted.Type !== "bind" || mounted.RW !== (approved.access === "rw")) {
      throw new Error(`Created container has an unapproved mount: ${mounted.Destination}`);
    }
  }
  return container.Id;
}
