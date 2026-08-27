import type {
	ProviderId,
	RecommendationCard,
	RecommendationPage,
} from "@mineradio/shared";

export interface HomeProviderPreview {
	provider: ProviderId;
	title: string;
	kind: RecommendationPage["list"][number]["kind"];
	cards: RecommendationCard[];
}

const PROVIDER_ORDER: ProviderId[] = ["netease", "qq", "kugou", "soda"];
export const HOME_PROVIDER_PREVIEW_CARD_LIMIT = 8;

export function buildHomeRecommendationPreviews(
	pages: RecommendationPage[],
): HomeProviderPreview[] {
	return PROVIDER_ORDER.flatMap((provider) => {
		const module = pages
			.filter((page) => page.provider === provider)
			.flatMap((page) => page.list[0] ?? [])
			.find((module) => module.list.length > 0);
		if (!module) return [];

		return [{
			provider,
			title: module.title,
			kind: module.kind,
			cards: module.list.slice(0, HOME_PROVIDER_PREVIEW_CARD_LIMIT),
		}];
	});
}
