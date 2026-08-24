import type { ReactElement } from "react";
import type {
	ProviderId,
	RecommendationCard as RecommendationCardData,
	RecommendationModule,
} from "@mineradio/shared";
import { HOME_PROVIDER_LABELS } from "../home/home-provider-labels";
import { RecommendationCard } from "./RecommendationCard";
import { chunkIntoColumns } from "./recommendation-page-policy";

export interface RecommendationModuleRailProps {
	provider: ProviderId;
	module: RecommendationModule;
	anchor?: boolean;
	onPlayTrack?: (provider: ProviderId, card: RecommendationCardData) => void;
	onOpenPlaylist?: (provider: ProviderId, card: RecommendationCardData) => void;
}

/** 推荐页里单条 module rail：Provider 分段标题 + 卡片行。 */
export function RecommendationModuleRail({
	provider,
	module,
	anchor,
	onPlayTrack,
	onOpenPlaylist,
}: RecommendationModuleRailProps): ReactElement {
	const label = HOME_PROVIDER_LABELS[provider];
	const heading = module.title.trim() ? `${label} · ${module.title}` : label;

	return (
		<section
			className="home-rail-section"
			data-home-provider={provider}
			data-home-recommendation-segment={provider}
			data-home-recommendation-anchor={anchor ? "true" : undefined}
		>
			<div className="home-rail-section-head">
				<div className="home-rail-section-title home-recommendation-module-title">
					{heading}
				</div>
			</div>
			{module.kind === "Track" ? (
				<div className="home-recommendation-track-row">
					{chunkIntoColumns(module.list, 3).map((column, columnIndex) => (
						<div
							className="home-recommendation-track-column"
							key={`${provider}-column-${columnIndex}`}
						>
							{column.map((card, index) => (
								<RecommendationCard
									key={`${provider}-${card.id}-${index}`}
									provider={provider}
									moduleKind={module.kind}
									card={card}
									index={index}
									onPlayTrack={onPlayTrack}
									onOpenPlaylist={onOpenPlaylist}
								/>
							))}
						</div>
					))}
				</div>
			) : (
				<div
					className={
						module.kind === "Mixed" && provider === "netease"
							? "home-recommendation-netease-mixed-row"
							: "home-recommendation-tile-row"
					}
				>
					{module.list.map((card, index) => (
						<RecommendationCard
							key={`${provider}-${card.id}-${index}`}
							provider={provider}
							moduleKind={module.kind}
							card={card}
							index={index}
							onPlayTrack={onPlayTrack}
							onOpenPlaylist={onOpenPlaylist}
						/>
					))}
				</div>
			)}
		</section>
	);
}
