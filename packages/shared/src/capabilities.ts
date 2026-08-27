import { z } from "zod";
import { ProviderCapabilitySchema, ProviderIdSchema } from "./provider";

export const ProviderStatusSchema = z.object({
  providerId: ProviderIdSchema,
  available: z.boolean(),
  capabilities: z.array(ProviderCapabilitySchema).default([]),
  message: z.string().optional()
});

export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const CapabilityMatrixSchema = z.object({
  version: z.string(),
  providers: z.array(ProviderStatusSchema).default([])
});

export type CapabilityMatrix = z.infer<typeof CapabilityMatrixSchema>;
