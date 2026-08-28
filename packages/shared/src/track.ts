import { z } from "zod";
import { ProviderIdSchema } from "./provider";
import { CoverSourceSchema } from "./cover-source";

export const PlayableStateSchema = z.enum([
  "unknown",
  "playable",
  "login_required",
  "vip_required",
  "paid_required",
  "copyright_unavailable",
  "trial_only",
  "unavailable"
]);

export const TrackSchema = z.object({
  provider: ProviderIdSchema,
  id: z.string().min(1),
  sourceId: z.string().min(1),
  mediaMid: z.string().optional(),
  title: z.string(),
  artists: z.array(z.string()),
  album: z.string().optional().default(""),
  coverUrl: CoverSourceSchema.optional().default(""),
  durationMs: z.number().int().nonnegative().optional(),
  qualityHints: z.array(z.string()).default([]),
  playableState: PlayableStateSchema.default("unknown")
});

export type PlayableState = z.infer<typeof PlayableStateSchema>;
export type Track = z.infer<typeof TrackSchema>;

export const TrackArraySchema = z.array(TrackSchema);
