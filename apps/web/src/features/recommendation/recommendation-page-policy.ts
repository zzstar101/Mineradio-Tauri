import type {
	ProviderId,
	RecommendationCard as RecommendationCardData,
	RecommendationModule,
	RecommendationPage,
	Track,
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

/** 标题替补逻辑（渲染与播放共用）：有 title 时 subtitle 独立展示；
 *  无 title 有 subtitle → subtitle 升 title，无独立 subtitle；
 *  均无 → title="" subtitle=""（均不渲染）。 */
export function resolveRecommendationCardDisplay(
	card: RecommendationCardData,
): { title: string; subtitle: string } {
	if (card.title) {
		return { title: card.title, subtitle: card.subtitle || "" };
	}
	if (card.subtitle) {
		return { title: card.subtitle, subtitle: "" };
	}
	return { title: "", subtitle: "" };
}

/**
 * 推荐卡片 → 可播放 Track（前端现场合成，零 API 改动）。
 * card.id 即真 track id，交叉源 song-url 直连即可取 URL；
 * artists 由 subtitle 的 "/" 分隔拆出（title+artists 只影响兜底搜索质量）。
 */
export function buildTrackFromRecommendationCard(
	provider: ProviderId,
	card: RecommendationCardData,
): Track {
	const display = resolveRecommendationCardDisplay(card);
	const hasIndependentSubtitle = Boolean(card.title && card.subtitle);
	const artists = hasIndependentSubtitle
		? card.subtitle
				.split("/")
				.map((part) => part.trim())
				.filter(Boolean)
		: [];
	return {
		provider,
		id: card.id,
		sourceId: card.id,
		title: display.title,
		artists,
		album: "",
		coverUrl: card.coverUrl,
		qualityHints: [],
		playableState: "playable",
	};
}
