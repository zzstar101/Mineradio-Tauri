import { z } from "zod";
import { ProviderIdSchema } from "./provider";
import { CoverSourceSchema } from "./cover-source";

export const RecommendationCardKindSchema = z.enum([
	"track",
	"stream",
	"playlist",
	"unknown",
]);

export const RecommendationModuleKindSchema = z.enum([
	"track",
	"mixed",
	"playlist",
	"unknown",
]);

export const RecommendationCardSchema = z.object({
	id: z.string(),
	title: z.string().default(""),
	subtitle: z.string().default(""),
	kind: RecommendationCardKindSchema.default("unknown"),
	coverUrl: CoverSourceSchema.default(""),
	collected: z.boolean().nullable().optional(),
});

export const RecommendationModuleSchema = z.object({
	title: z.string().default(""),
	list: z.array(RecommendationCardSchema).default([]),
	kind: RecommendationModuleKindSchema.default("unknown"),
});

export const RecommendationPageSchema = z.object({
	provider: ProviderIdSchema,
	list: z.array(RecommendationModuleSchema).default([]),
});

export const RecommendationPageArraySchema = z.array(RecommendationPageSchema);

export type RecommendationCardKind = z.infer<typeof RecommendationCardKindSchema>;
export type RecommendationModuleKind = z.infer<typeof RecommendationModuleKindSchema>;
export type RecommendationCard = z.infer<typeof RecommendationCardSchema>;
export type RecommendationModule = z.infer<typeof RecommendationModuleSchema>;
export type RecommendationPage = z.infer<typeof RecommendationPageSchema>;
