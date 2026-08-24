import { useEffect, useRef, type ReactElement } from "react";
import type { EmptyHomeHostProps } from "../../home/EmptyHomeHost";
import { HOME_PROVIDER_LABELS } from "../home/home-provider-labels";
import {
	flattenRecommendationFeed,
	type RecommendationDetail,
} from "./recommendation-page-policy";
import { RecommendationModuleRail } from "./RecommendationModuleRail";

/**
 * 独立推荐页：纵向流式渲染全部 provider 的推荐模块（统一 feed）。
 * 打开即用 EmptyHomeHost 已加载的 recommendations，不重新请求；
 * 工具栏「刷新」走 props.onRetryRecommendations（refresh: true）。
 */
export function RecommendationPage({
	props,
	detail,
}: {
	props: EmptyHomeHostProps;
	detail: RecommendationDetail;
}): ReactElement {
	const segments = flattenRecommendationFeed(props.recommendations ?? []);
	const feedRef = useRef<HTMLDivElement | null>(null);
	const firstAnchorIndex = segments.findIndex(
		(segment) => segment.provider === detail.anchorProvider,
	);

	useEffect(() => {
		if (firstAnchorIndex < 0) return;
		const feed = feedRef.current;
		const target = feed?.querySelector('[data-home-recommendation-anchor="true"]');
		if (feed && target instanceof HTMLElement) {
			feed.scrollTop = Math.max(0, target.offsetTop - 12);
		}
	}, [firstAnchorIndex]);

	const providerName = HOME_PROVIDER_LABELS[detail.anchorProvider];

	return (
		<section id="empty-home" className="home-detail-active" aria-label="Recommendations">
			<div
				className="home-playlist-detail home-recommendation-page"
				data-home-recommendation
				data-home-provider={detail.anchorProvider}
			>
				<div className="home-detail-toolbar">
					<button
						className="home-detail-back"
						type="button"
						onClick={props.onCloseRecommendations}
					>
						返回首页
					</button>
					<div className="home-detail-toolbar-group">
						<button
							className="home-detail-refresh"
							type="button"
							onClick={props.onRetryRecommendations}
						>
							刷新
						</button>
						<div className="home-detail-provider">{providerName}</div>
					</div>
				</div>
				<div className="home-recommendation-page-feed" ref={feedRef}>
					{segments.length === 0 ? (
						<div className="home-detail-empty">暂无推荐内容</div>
					) : (
						segments.map((segment, index) => (
							<RecommendationModuleRail
								key={`${segment.provider}-${segment.module.title}-${index}`}
								provider={segment.provider}
								module={segment.module}
								anchor={
									segment.provider === detail.anchorProvider &&
									index === firstAnchorIndex
								}
							/>
						))
					)}
				</div>
			</div>
		</section>
	);
}
