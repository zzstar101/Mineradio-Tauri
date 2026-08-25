import type {
	DiscoverHomeResponse,
	PodcastBeatmapResponse,
	PodcastDetailResponse,
	PodcastMyItemsResponse,
	PodcastMyResponse,
	ProviderId,
	RecommendationPage,
	Track,
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
	/** 流式电台续拉：按推荐 Stream 卡片的 id 取下一首 */
	streamNext(provider: ProviderId, id: string): Promise<Track>;
	podcastDetail(id: string): Promise<PodcastDetailResponse>;
	podcastMy(): Promise<PodcastMyResponse>;
	podcastMyItems(key: string, limit?: number, offset?: number): Promise<PodcastMyItemsResponse>;
	podcastDjBeatmap(
		url: string,
		durationSec?: number,
		introSec?: number,
	): Promise<PodcastBeatmapResponse>;
}
