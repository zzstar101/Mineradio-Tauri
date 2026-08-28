import { z } from "zod";
import { TrackSchema } from "./track";
import { CoverSourceSchema } from "./cover-source";

const PodcastIdSchema = z.preprocess((value) => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return value;
}, z.string().min(1));

export const PodcastRadioSchema = z.object({
  id: PodcastIdSchema,
  rid: PodcastIdSchema,
  name: z.string(),
  coverUrl: CoverSourceSchema.optional().default(""),
  description: z.string().optional().default(""),
  djName: z.string().optional().default(""),
  category: z.string().optional().default(""),
  programCount: z.number().int().nonnegative().optional().default(0),
  subCount: z.number().int().nonnegative().optional().default(0)
});

export const PodcastProgramSchema = TrackSchema.extend({
  type: z.literal("podcast"),
  programId: z.string().optional().default(""),
  radioId: z.string().optional().default(""),
  radioName: z.string().optional().default(""),
  djName: z.string().optional().default(""),
  description: z.string().optional().default(""),
  createTime: z.number().optional().default(0),
  serialNum: z.number().optional().default(0)
});

export const PodcastSearchResponseSchema = z.object({
  podcasts: z.array(PodcastRadioSchema).default([]),
  total: z.number().int().nonnegative().default(0)
});

export const PodcastHotResponseSchema = z.object({
  podcasts: z.array(PodcastRadioSchema).default([]),
  more: z.boolean().default(false)
});

export const PodcastDetailResponseSchema = z.object({
  podcast: PodcastRadioSchema
});

export const PodcastProgramsResponseSchema = z.object({
  radio: PodcastRadioSchema.partial().extend({
    id: z.string().optional(),
    rid: z.string().optional()
  }),
  programs: z.array(PodcastProgramSchema).default([]),
  more: z.boolean().default(false),
  total: z.number().int().nonnegative().default(0)
});

export const PodcastCollectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  sub: z.string().optional().default(""),
  itemType: z.enum(["radio", "voice"]).default("radio"),
  count: z.number().int().nonnegative().default(0),
  coverUrl: CoverSourceSchema.optional().default("")
});

export const PodcastMyResponseSchema = z.object({
  loggedIn: z.boolean(),
  collections: z.array(PodcastCollectionSchema).default([])
});

export const PodcastMyItemsResponseSchema = PodcastCollectionSchema.extend({
  loggedIn: z.boolean(),
  items: z.array(z.union([PodcastRadioSchema, PodcastProgramSchema])).default([])
});

export const PodcastBeatmapResponseSchema = z.object({
  ok: z.literal(true),
  map: z.record(z.string(), z.unknown())
});

export type PodcastRadio = z.infer<typeof PodcastRadioSchema>;
export type PodcastProgram = z.infer<typeof PodcastProgramSchema>;
export type PodcastSearchResponse = z.infer<typeof PodcastSearchResponseSchema>;
export type PodcastHotResponse = z.infer<typeof PodcastHotResponseSchema>;
export type PodcastDetailResponse = z.infer<typeof PodcastDetailResponseSchema>;
export type PodcastProgramsResponse = z.infer<typeof PodcastProgramsResponseSchema>;
export type PodcastCollection = z.infer<typeof PodcastCollectionSchema>;
export type PodcastMyResponse = z.infer<typeof PodcastMyResponseSchema>;
export type PodcastMyItemsResponse = z.infer<typeof PodcastMyItemsResponseSchema>;
export type PodcastBeatmapResponse = z.infer<typeof PodcastBeatmapResponseSchema>;
