import type {
	DiscoverHomeResponse,
	PodcastBeatmapResponse,
	PodcastDetailResponse,
	PodcastMyItemsResponse,
	PodcastMyResponse,
	RecommendationPage,
	WeatherRadioResponse,
} from "@mineradio/shared";

export interface WeatherRadioQuery {
	city?: string;
	q?: string;
	location?: string;
	lat?: number;
	lon?: number;
	timezone?: string;
}

export interface DiscoverPort {
	weatherRadio(params?: WeatherRadioQuery): Promise<WeatherRadioResponse>;
	discoverHome(): Promise<DiscoverHomeResponse>;
	recommendationPages(options?: { refresh?: boolean }): Promise<RecommendationPage[]>;
	podcastDetail(id: string): Promise<PodcastDetailResponse>;
	podcastMy(): Promise<PodcastMyResponse>;
	podcastMyItems(key: string, limit?: number, offset?: number): Promise<PodcastMyItemsResponse>;
	podcastDjBeatmap(
		url: string,
		durationSec?: number,
		introSec?: number,
	): Promise<PodcastBeatmapResponse>;
}
