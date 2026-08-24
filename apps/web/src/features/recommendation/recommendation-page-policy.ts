import type {
	ProviderId,
	RecommendationModule,
	RecommendationPage,
} from "@mineradio/shared";

export interface RecommendationFeedSegment {
	provider: ProviderId;
	module: RecommendationModule;
}

/** 推荐页状态：被点击进入的 provider 作为锚点分段。 */
export interface RecommendationDetail {
	anchorProvider: ProviderId;
}

/**
 * 把 recommendation_pages 按 API 返回顺序压平成纵向 feed 的分段列表，
 * 跳过没有卡片的空 module。流式渲染与单测共用。
 */
export function flattenRecommendationFeed(
	pages: RecommendationPage[],
): RecommendationFeedSegment[] {
	return pages.flatMap((page) =>
		page.list
			.filter((module) => module.list.length > 0)
			.map((module) => ({ provider: page.provider, module })),
	);
}

/** Track 模块专用：把卡片列表按每列 N 张切分成竖排列。 */
export function chunkIntoColumns<T>(items: T[], perColumn: number): T[][] {
	const columns: T[][] = [];
	for (let i = 0; i < items.length; i += perColumn) {
		columns.push(items.slice(i, i + perColumn));
	}
	return columns;
}
