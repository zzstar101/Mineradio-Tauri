import type { CSSProperties, ReactElement } from "react";
import type {
	ProviderId,
	RecommendationCard as RecommendationCardData,
	RecommendationModuleKind,
} from "@mineradio/shared";
import { resolveRecommendationCardDisplay } from "./recommendation-page-policy";

function coverStyle(url: string | undefined): CSSProperties | undefined {
	return url ? { backgroundImage: `url("${url}")` } : undefined;
}

export interface RecommendationCardProps {
	provider: ProviderId;
	moduleKind: RecommendationModuleKind;
	card: RecommendationCardData;
	index: number;
	onPlayTrack?: (provider: ProviderId, card: RecommendationCardData) => void;
	onOpenPlaylist?: (provider: ProviderId, card: RecommendationCardData) => void;
}

/**
 * 推荐卡片渲染（按模块 kind 决定三段布局）+ 点击交互（按卡片 kind 分发）：
 * Track → 播放；Playlist → 打开歌单；Stream 本轮不做，保持无交互。
 */
export function RecommendationCard({
	provider,
	moduleKind,
	card,
	index,
	onPlayTrack,
	onOpenPlaylist,
}: RecommendationCardProps): ReactElement {
	const { title: cardTitle, subtitle: cardSubtitle } =
		resolveRecommendationCardDisplay(card);

	const interactive =
		(card.kind === "track" && Boolean(onPlayTrack)) ||
		(card.kind === "playlist" && Boolean(onOpenPlaylist));

	const handleActivate = () => {
		if (card.kind === "track") onPlayTrack?.(provider, card);
		else if (card.kind === "playlist") onOpenPlaylist?.(provider, card);
	};

	const interactiveProps = interactive
		? {
				onClick: handleActivate,
				"data-card-interactive": "true",
			}
		: {};

	if (moduleKind === "track") {
		return (
			<div
				className="home-recommendation-card-track"
				data-home-recommendation-card={index}
				data-card-kind={card.kind}
				{...interactiveProps}
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

	if (moduleKind === "mixed" && provider === "netease") {
		return (
			<div
				className="home-recommendation-card home-recommendation-card-netease-mixed"
				data-home-recommendation-card={index}
				data-card-kind={card.kind}
				{...interactiveProps}
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
			{...interactiveProps}
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
