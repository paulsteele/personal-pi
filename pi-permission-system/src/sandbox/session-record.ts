import { z } from "zod";
import { mountGrantSchema } from "./mounts.ts";
import { toolInventorySchema } from "./tool-inventory.ts";
import { toolImageMountsSchema } from "./tool-image-mounts.ts";
import { volumeGrantSchema } from "./volumes.ts";

export const sessionRecordSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string(),
    startupDirectory: z.string(),
    definitionRevision: z.string(),
    baseDefinitionRevision: z.string().optional(),
    generation: z.number().int().positive(),
    mounts: z.array(mountGrantSchema),
    volumes: z.array(volumeGrantSchema).optional(),
    approvedPorts: z.array(z.number().int().min(1).max(65535)).optional(),
    inactiveSinceUnixMs: z.number().int().nonnegative().optional(),
    containerPrunedAtUnixMs: z.number().int().nonnegative().optional(),
    environment: z
      .object({
        container: z.string(),
        image: z.string(),
        user: z.string(),
        workspace: z.string(),
        configuration: z.record(z.string(), z.unknown()),
        remoteEnvironment: z.record(z.string(), z.string()).optional(),
        toolInventory: toolInventorySchema.optional(),
        toolImageMounts: toolImageMountsSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type SandboxSessionRecord = z.output<typeof sessionRecordSchema>;
