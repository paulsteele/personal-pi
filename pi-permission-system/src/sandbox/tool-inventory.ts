import { z } from "zod";

export const toolInventorySchema = z.strictObject({
  version: z.literal(1),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  platform: z.string(),
  tools: z.array(
    z.strictObject({
      id: z.string(),
      version: z.string(),
      executable: z.string(),
      source: z.enum(["global", "project"]),
      imageId: z.string(),
    }),
  ),
});

export type ToolInventory = z.output<typeof toolInventorySchema>;
