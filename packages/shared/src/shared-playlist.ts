import { z } from "zod";
import { ProviderIdSchema } from "./provider";
import { TrackSchema } from "./track";
import { CoverSourceSchema } from "./cover-source";

export const SharedPlaylistSourceSchema = z.enum(["netease", "qq", "kugou", "qishui", "apple-music"]);

export const SharedPlaylistImportRequestSchema = z.object({
  text: z.string().optional().default(""),
  url: z.string().optional().default("")
});

export const SharedPlaylistInfoSchema = z.object({
  provider: SharedPlaylistSourceSchema,
  id: z.string().min(1),
  name: z.string(),
  coverUrl: CoverSourceSchema.optional().default(""),
  trackCount: z.number().int().nonnegative().optional(),
  trackIds: z.array(z.string()).default([]),
  subscribed: z.boolean().optional().default(false),
  sourceUrl: z.string().optional().default("")
});

export const SharedPlaylistImportResultSchema = z.object({
  provider: SharedPlaylistSourceSchema,
  playlist: SharedPlaylistInfoSchema,
  tracks: z.array(TrackSchema).default([]),
  trackCount: z.number().int().nonnegative().default(0),
  loadedCount: z.number().int().nonnegative().default(0),
  partial: z.boolean().default(false),
  partialReason: z.string().default("")
});

export type SharedPlaylistSource = z.infer<typeof SharedPlaylistSourceSchema>;
export type SharedPlaylistImportRequest = z.input<typeof SharedPlaylistImportRequestSchema>;
export type SharedPlaylistInfo = z.infer<typeof SharedPlaylistInfoSchema>;
export type SharedPlaylistImportResult = z.infer<typeof SharedPlaylistImportResultSchema>;
