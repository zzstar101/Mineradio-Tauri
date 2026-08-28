import { z } from "zod";
import { ProviderIdSchema } from "./provider";
import { TrackSchema } from "./track";
import { CoverSourceSchema } from "./cover-source";

export const PlaylistSummarySchema = z.object({
  provider: ProviderIdSchema,
  id: z.string().min(1),
  name: z.string(),
  coverUrl: CoverSourceSchema.optional().default(""),
  trackCount: z.number().int().nonnegative().optional(),
  trackIds: z.array(z.string()).default([]),
  collected: z.boolean().nullable().optional(),
  subscribed: z.boolean().optional().default(false)
});

export const PlaylistSummaryArraySchema = z.array(PlaylistSummarySchema);

export const PlaylistDetailSchema = PlaylistSummarySchema.extend({
  tracks: z.array(TrackSchema).default([]),
  /** 服务端权威翻页信号：true=还有下一页，false=到头，null/缺省=未提供 */
  hasMore: z.boolean().nullable().optional()
});

export type PlaylistSummary = z.infer<typeof PlaylistSummarySchema>;
export type PlaylistDetail = z.infer<typeof PlaylistDetailSchema>;
