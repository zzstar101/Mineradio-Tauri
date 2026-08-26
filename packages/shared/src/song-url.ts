import { z } from "zod";
import { ProviderVipIconSchema } from "./session";
import { TrackSchema } from "./track";

const PLAYBACK_QUALITY_VALUES = ["jymaster", "hires", "lossless", "exhigh", "standard"] as const;
export type PlaybackQuality = (typeof PLAYBACK_QUALITY_VALUES)[number];
export type PlaybackQualityRequest = string;

const PLAYBACK_QUALITY_ALIASES: Record<string, PlaybackQuality> = {
	jymaster: "jymaster",
	master: "jymaster",
	svip: "jymaster",
	hires: "hires",
	"hi-res": "hires",
	highres: "hires",
	highest: "hires",
	lossless: "lossless",
	flac: "lossless",
	sq: "lossless",
	exhigh: "exhigh",
	high: "exhigh",
	"320k": "exhigh",
	hq: "exhigh",
	standard: "standard",
	normal: "standard",
	std: "standard",
};

const PLAYBACK_QUALITY_REQUEST_ALIASES: Record<string, string> = {
	master: "jymaster",
	svip: "jymaster",
	"hi-res": "hires",
	highres: "hires",
	highest: "hires",
	sq: "lossless",
	high: "exhigh",
	"320k": "exhigh",
	hq: "exhigh",
	normal: "standard",
	std: "standard",
};

export const PlaybackQualitySchema = z.preprocess((value) => {
	const normalized = typeof value === "string" ? PLAYBACK_QUALITY_ALIASES[value.toLowerCase()] : undefined;
	return normalized ?? value;
}, z.enum(PLAYBACK_QUALITY_VALUES));

export const PlaybackQualityRequestSchema = z.preprocess((value) => {
	const normalized = typeof value === "string" ? PLAYBACK_QUALITY_REQUEST_ALIASES[value.toLowerCase()] : undefined;
	return normalized ?? value;
}, z.string().min(1));

export const SongUrlRequestSchema = z.object({
	track: TrackSchema,
	quality: PlaybackQualityRequestSchema.optional(),
});

export type SongUrlRequest = z.infer<typeof SongUrlRequestSchema>;

export const PlaybackRestrictionCategorySchema = z.enum([
	"login_required",
	"vip_required",
	"paid_required",
	"trial_only",
	"copyright_unavailable",
	"url_unavailable",
	"unavailable",
]);

export const PlaybackRestrictionSchema = z.object({
	provider: z.string().min(1),
	category: PlaybackRestrictionCategorySchema,
	action: z.string().optional().default(""),
	message: z.string().min(1),
	code: z.number().optional(),
	fee: z.number().optional(),
	rawMessage: z.string().optional(),
	missingPlaybackKey: z.boolean().optional(),
});

export type PlaybackRestrictionCategory = z.infer<typeof PlaybackRestrictionCategorySchema>;
export type PlaybackRestriction = z.infer<typeof PlaybackRestrictionSchema>;

export const SongUrlResultSchema = z.object({
	url: z.string().nullable(),
	provider: z.string().optional(),
	trial: z.boolean().optional(),
	playable: z.boolean().optional(),
	level: z.string().optional(),
	quality: z.string().optional(),
	br: z.number().int().nonnegative().optional(),
	requestedQuality: PlaybackQualityRequestSchema.nullable().optional(),
	loggedIn: z.boolean().optional(),
	vipType: z.number().optional(),
	vipLevel: z.enum(["none", "vip", "svip"]).optional(),
	isVip: z.boolean().optional(),
	isSvip: z.boolean().optional(),
	vipLabel: z.string().optional(),
	vipIcon: ProviderVipIconSchema.optional(),
	vipIconUrl: z.string().optional(),
	vipTier: z.number().int().nonnegative().optional(),
	vipLevelName: z.string().optional(),
	playbackKeyReady: z.boolean().optional(),
	restriction: PlaybackRestrictionSchema.optional(),
	reason: PlaybackRestrictionCategorySchema.optional(),
	message: z.string().optional(),
	tried: z.array(z.string()).optional(),
	filename: z.string().optional(),
	qqCode: z.number().optional(),
	rawMessage: z.string().optional(),
});

export type SongUrlResult = z.infer<typeof SongUrlResultSchema>;

export const TrackQualityOptionSchema = z.object({
	provider: z.string().min(1),
	id: z.string().min(1),
	label: z.string().min(1),
	short: z.string().optional(),
	detail: z.string().optional(),
	requestQuality: PlaybackQualityRequestSchema,
	level: z.string().optional(),
	type: z.string().optional(),
	br: z.number().int().nonnegative().optional(),
	size: z.number().int().nonnegative().optional(),
	format: z.string().optional(),
	source: z.enum(["resolved", "declared"]).default("resolved"),
});

export const TrackQualityAvailabilitySchema = z.object({
	provider: z.string().min(1),
	trackId: z.string().min(1),
	defaultQuality: PlaybackQualityRequestSchema.optional(),
	qualities: z.array(TrackQualityOptionSchema),
});

export type TrackQualityOption = z.infer<typeof TrackQualityOptionSchema>;
export type TrackQualityAvailability = z.infer<typeof TrackQualityAvailabilitySchema>;
