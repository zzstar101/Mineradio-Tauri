import { z } from "zod";
import { ProviderCapabilitySchema, ProviderIdSchema } from "./provider";

const RuntimeCapabilityEvidenceSchema = z.object({
  /** Adapter/service is registered in the native runtime. */
  registered: z.boolean(),
  /** Required runtime configuration is present. */
  configured: z.boolean(),
  /** An operational probe or request has succeeded for this runtime generation. */
  available: z.boolean(),
  /** Release field evidence has been reviewed; never inferred from registration. */
  fieldVerified: z.boolean()
});

export const ProviderStatusSchema = RuntimeCapabilityEvidenceSchema.extend({
  providerId: ProviderIdSchema,
  capabilities: z.array(ProviderCapabilitySchema).default([]),
  message: z.string().optional()
});

export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const HomeServiceIdSchema = z.enum(["recommendations", "weatherRadio"]);
export const HomeServiceStatusSchema = RuntimeCapabilityEvidenceSchema.extend({
  serviceId: HomeServiceIdSchema,
  message: z.string().optional()
});

export type HomeServiceStatus = z.infer<typeof HomeServiceStatusSchema>;

export const CapabilityMatrixSchema = z.object({
  version: z.string(),
  providers: z.array(ProviderStatusSchema).default([]),
  services: z.array(HomeServiceStatusSchema).default([])
});

export type CapabilityMatrix = z.infer<typeof CapabilityMatrixSchema>;
