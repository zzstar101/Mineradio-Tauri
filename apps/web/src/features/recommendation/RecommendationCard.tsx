import type { CSSProperties, ReactElement } from "react";
import type {
	ProviderId,
	RecommendationCard as RecommendationCardData,
	RecommendationModuleKind,
} from "@mineradio/shared";

function coverStyle(url: string | undefined): CSSProperties | undefined {
	return url ? { backgroundImage: `url("${url}")` } : undefined;
}

/** 标题替补逻辑：有 title 时 subtitle 独立展示；
 *  无 title 有 subtitle → subtitle 升 title，无独立 subtitle；
 *  均无 → title="" subtitle=""（均不渲染）。 */
function resolvedDisplay(card: RecommendationCardData): { title: string; subtitle: string } {
	if (card.title) {
		return { title: card.title, subtitle: card.subtitle || "" };
	}
	if (card.subtitle) {
		return { title: card.subtitle, subtitle: "" };
	}
	return { title: "", subtitle: "" };
}

export interface RecommendationCardProps {
	provider: ProviderId;
	moduleKind: RecommendationModuleKind;
	card: RecommendationCardData;
	index: number;
}

/**
 * 推荐卡片渲染（按模块 kind 决定三段布局）。
 */
export function RecommendationCard({
	provider,
	moduleKind,
	card,
	index,
}: RecommendationCardProps): ReactElement {
	const { title: cardTitle, subtitle: cardSubtitle } = resolvedDisplay(card);

	if (moduleKind === "Track") {
		return (
			<div
				className="home-recommendation-card-track"
				data-home-recommendation-card={index}
				data-card-kind={card.kind}
			>
				<div
					className={`home-recommendation-track-cover${card.coverUrl ? " has-cover" : ""}`}
					style={coverStyle(card.coverUrl)}
				/>
				<div className="home-recommendation-track-text">
					{cardTitle ? <div className="home-recommendation-title">{cardTitle}</div> : null}
					{cardSubtitle ? <div className="home-recommendation-subtitle">{cardSubtitle}</div> : null}
				</div>
			</div>
		);
	}

	if (moduleKind === "Mixed" && provider === "netease") {
		return (
			<div
				className="home-recommendation-card home-recommendation-card-netease-mixed"
				data-home-recommendation-card={index}
				data-card-kind={card.kind}
			>
				<div
					className={`home-recommendation-media-cover${card.coverUrl ? " has-cover" : ""}`}
					style={coverStyle(card.coverUrl)}
				/>
				{cardTitle ? (
					<div className="home-recommendation-netease-title">
						<div className="home-recommendation-title">{cardTitle}</div>
					</div>
				) : null}
				{cardSubtitle ? (
					<div className="home-recommendation-netease-footer">
						<div className="home-recommendation-subtitle">{cardSubtitle}</div>
					</div>
				) : null}
			</div>
		);
	}

	return (
		<div
			className="home-recommendation-media"
			data-home-recommendation-card={index}
			data-card-kind={card.kind}
		>
			<div className="home-recommendation-cover-card">
				<div
					className={`home-recommendation-media-cover${card.coverUrl ? " has-cover" : ""}`}
					style={coverStyle(card.coverUrl)}
				/>
			</div>
			{cardTitle ? (
				<div className="home-recommendation-media-text">
					<div className="home-recommendation-title">{cardTitle}</div>
					{cardSubtitle ? <div className="home-recommendation-subtitle">{cardSubtitle}</div> : null}
				</div>
			) : null}
		</div>
	);
}