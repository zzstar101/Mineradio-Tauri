import { useEffect, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from "react";
import type { PodcastRadio, ProviderId, Track } from "@mineradio/shared";
import type { SearchExperiencePort } from "../../ports/music/search-port";
import { isPlayable } from "../search/play-search-result";
import { useSearchStore, type SearchMode } from "../../stores/search-store";
import { searchSessionController } from "../../features/search/search-session-runtime";
import { resolveVirtualListWindow, type VirtualListWindow } from "./virtual-list";
import { useCoverSourceResolver } from "../../cover/resolved-cover-source";

export interface SearchDetailPageProps {
	client: SearchExperiencePort | null;
	onClose: () => void;
	onPlayResults: (tracks: Track[], index: number) => void;
	onAppendQueue: (track: Track) => void;
	onResultNext: (track: Track) => void;
	onResultLike: (track: Track) => void;
	onResultCollect: (track: Track) => void;
	onArtistSearch: (artist: string, track: Track) => void;
	isResultLiked?: (track: Track) => boolean;
	isResultLikeBusy?: (track: Track) => boolean;
}

const SEARCH_DETAIL_ROW_HEIGHT = 68;
const SEARCH_DETAIL_VIEWPORT_HEIGHT = 560;
const SEARCH_DETAIL_VIRTUAL_THRESHOLD = 90;

const SEARCH_DETAIL_MODES: Array<{ mode: SearchMode; label: string; sub: string }> = [
	{ mode: "song", label: "全部", sub: "跨平台" },
	{ mode: "netease", label: "网易云", sub: "NE" },
	{ mode: "qq", label: "QQ 音乐", sub: "QQ" },
	{ mode: "podcast", label: "播客", sub: "Podcast" },
];

function providerLabel(provider: ProviderId): string {
	if (provider === "netease") return "网易云";
	if (provider === "qq") return "QQ";
	if (provider === "soda") return "汽水";
	return provider;
}

function trackArtists(track: Track): string {
	return track.artists.length ? track.artists.join(" / ") : "未知艺人";
}

function formatDurationMs(durationMs: number | undefined): string {
	if (!durationMs) return "";
	const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function virtualListStyle(window: VirtualListWindow): CSSProperties | undefined {
	return window.virtualized
		? {
			maxHeight: SEARCH_DETAIL_VIEWPORT_HEIGHT,
			overflowY: "auto",
			paddingTop: window.paddingTop,
			paddingBottom: window.paddingBottom,
		}
		: undefined;
}

function firstArtist(track: Track): string {
	return track.artists.find((artist) => artist.trim().length > 0)?.trim() ?? "";
}

function coverStyle(url: string | undefined): CSSProperties | undefined {
	return url ? { backgroundImage: `url("${url}")` } : undefined;
}

export function SearchDetailPage({
	client,
	onClose,
	onPlayResults,
	onAppendQueue,
	onResultNext,
	onResultLike,
	onResultCollect,
	onArtistSearch,
	isResultLiked,
	isResultLikeBusy,
}: SearchDetailPageProps): ReactElement | null {
	const resolveCover = useCoverSourceResolver();
	const resolvedCoverStyle = (source: unknown) => coverStyle(resolveCover(source).uri);
	const detailOpen = useSearchStore((s) => s.detailOpen);
	const keyword = useSearchStore((s) => s.keyword);
	const mode = useSearchStore((s) => s.mode);
	const results = useSearchStore((s) => s.results);
	const podcasts = useSearchStore((s) => s.podcasts);
	const programs = useSearchStore((s) => s.programs);
	const selectedPodcast = useSearchStore((s) => s.selectedPodcast);
	const loading = useSearchStore((s) => s.loading);
	const loadingNext = useSearchStore((s) => s.loadingNext);
	const error = useSearchStore((s) => s.error);
	const exhausted = useSearchStore((s) => s.exhausted);
	const visibleCount = useSearchStore((s) => s.visibleCount);
	const recentQueries = useSearchStore((s) => s.recentQueries);
	const [draftKeyword, setDraftKeyword] = useState(keyword);
	const [songScrollTop, setSongScrollTop] = useState(0);
	const [podcastScrollTop, setPodcastScrollTop] = useState(0);
	const [programScrollTop, setProgramScrollTop] = useState(0);
	const controller = searchSessionController;

	useEffect(() => {
		setDraftKeyword(keyword);
	}, [keyword]);

	useEffect(() => {
		if (!detailOpen) return;
		controller.setPort(client);
		void controller.search(keyword, mode);
	}, [client, controller, detailOpen, keyword, mode]);

	const submitSearch = () => {
		setSongScrollTop(0);
		setPodcastScrollTop(0);
		setProgramScrollTop(0);
		controller.setPort(client);
		void controller.openDetail(draftKeyword, mode);
	};

	const closePage = () => {
		controller.closeDetail();
		onClose();
	};

	const selectMode = (nextMode: SearchMode) => {
		setSongScrollTop(0);
		setPodcastScrollTop(0);
		setProgramScrollTop(0);
		controller.setPort(client);
		void controller.openDetail(draftKeyword, nextMode);
	};

	const openPodcastPrograms = async (radio: PodcastRadio) => {
		setProgramScrollTop(0);
		controller.setPort(client);
		await controller.openPodcastPrograms(radio);
	};

	const playResult = (index: number) => {
		if (!results[index]) return;
		onPlayResults(results, index);
	};

	const playProgram = (index: number) => {
		if (!programs[index]) return;
		onPlayResults(programs, index);
	};

	const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			submitSearch();
		}
		if (event.key === "Escape") {
			closePage();
		}
	};

	if (!detailOpen) return null;

	const displayedResults = results.slice(0, visibleCount);
	const displayedPodcasts = podcasts.slice(0, visibleCount);
	const displayedPrograms = programs.slice(0, visibleCount);
	const songWindow = resolveVirtualListWindow({
		itemCount: displayedResults.length,
		rowHeight: SEARCH_DETAIL_ROW_HEIGHT,
		viewportHeight: SEARCH_DETAIL_VIEWPORT_HEIGHT,
		scrollTop: songScrollTop,
		threshold: SEARCH_DETAIL_VIRTUAL_THRESHOLD,
	});
	const visibleResults = displayedResults.slice(songWindow.startIndex, songWindow.endIndex);
	const podcastWindow = resolveVirtualListWindow({
		itemCount: displayedPodcasts.length,
		rowHeight: SEARCH_DETAIL_ROW_HEIGHT,
		viewportHeight: SEARCH_DETAIL_VIEWPORT_HEIGHT,
		scrollTop: podcastScrollTop,
		threshold: SEARCH_DETAIL_VIRTUAL_THRESHOLD,
	});
	const visiblePodcasts = displayedPodcasts.slice(podcastWindow.startIndex, podcastWindow.endIndex);
	const programWindow = resolveVirtualListWindow({
		itemCount: displayedPrograms.length,
		rowHeight: SEARCH_DETAIL_ROW_HEIGHT,
		viewportHeight: SEARCH_DETAIL_VIEWPORT_HEIGHT,
		scrollTop: programScrollTop,
		threshold: SEARCH_DETAIL_VIRTUAL_THRESHOLD,
	});
	const visiblePrograms = displayedPrograms.slice(programWindow.startIndex, programWindow.endIndex);
	const activeItemCount = mode === "podcast"
		? selectedPodcast ? programs.length : podcasts.length
		: results.length;
	const canLoadNext = visibleCount < activeItemCount || !exhausted;
	const activeMode = SEARCH_DETAIL_MODES.find((item) => item.mode === mode) ?? SEARCH_DETAIL_MODES[0]!;
	const showEmpty =
		!loading &&
		!error &&
		((mode === "podcast" && !podcasts.length && !programs.length) ||
			(mode !== "podcast" && !results.length));

	return (
		<section className="search-detail-page" data-search-detail aria-label="搜索详情页">
			<div className="search-detail-panel">
				<div className="search-detail-toolbar">
					<button className="search-detail-back" type="button" onClick={closePage}>返回</button>
					<div className="search-detail-provider">{activeMode.label}</div>
				</div>
				<div className="search-detail-hero">
					<div className="search-detail-copy">
						<div className="search-detail-kicker">搜索</div>
						<div className="search-detail-query-row">
							<input
								className="search-detail-input"
								type="text"
								aria-label="搜索歌曲、歌手、播客"
								value={draftKeyword}
								placeholder={mode === "podcast" ? "搜索播客，留空查看热门" : "搜索歌曲、歌手..."}
								onChange={(event) => setDraftKeyword(event.currentTarget.value)}
								onKeyDown={onInputKeyDown}
							/>
							<button className="search-detail-submit" type="button" onClick={submitSearch}>搜索</button>
						</div>
						<div className="search-detail-meta">
							<span>{keyword.trim() || (mode === "podcast" ? "热门播客" : "输入关键词开始搜索")}</span>
							<span>{loading ? "搜索中" : mode === "podcast" ? `${programs.length || podcasts.length} 条` : `${results.length} 首`}</span>
							<span>{activeMode.sub}</span>
						</div>
						{error ? <div className="search-detail-error">{error}</div> : null}
					</div>
				</div>
				<div className="search-detail-tabs" aria-label="搜索来源">
					{SEARCH_DETAIL_MODES.map((item) => (
						<button
							key={item.mode}
							type="button"
							className={item.mode === mode ? "active" : ""}
							aria-selected={item.mode === mode}
							onClick={() => selectMode(item.mode)}
						>
							<span>{item.label}</span>
							<strong>{item.sub}</strong>
						</button>
					))}
				</div>
				{mode === "podcast" && selectedPodcast ? (
					<div className="search-detail-podcast-head">
						<button className="search-detail-podcast-back" type="button" onClick={() => controller.backToPodcastResults()}>返回播客</button>
						<div className={`search-detail-cover${selectedPodcast.coverUrl ? " has-cover" : ""}`} style={resolvedCoverStyle(selectedPodcast.coverUrl)} />
						<div>
							<div className="search-detail-track-title">{selectedPodcast.name || "播客"}</div>
							<div className="search-detail-track-sub">{selectedPodcast.djName || selectedPodcast.category || `${selectedPodcast.programCount || programs.length} 期`}</div>
						</div>
					</div>
				) : null}
				<div className="search-detail-list-head">
					<div>#</div>
					<div>标题</div>
					<div>专辑 / 来源</div>
					<div>操作</div>
				</div>
				{loading ? <div className="search-detail-state">搜索中...</div> : null}
				{showEmpty ? (
					<div className="search-detail-empty">
						<div>{mode === "podcast" ? "没有找到播客" : "没有找到歌曲"}</div>
						{recentQueries.length ? (
							<div className="search-detail-recent">
								{recentQueries.slice(0, 5).map((item) => (
									<button key={`${item.mode}:${item.keyword}`} type="button" onClick={() => {
										setDraftKeyword(item.keyword);
										controller.setPort(client);
										void controller.openDetail(item.keyword, mode);
									}}>
										{item.keyword || "热门播客"}
									</button>
								))}
							</div>
						) : null}
					</div>
				) : null}
				{mode !== "podcast" && results.length ? (
					<div
						className="search-detail-list"
						data-virtualized={songWindow.virtualized ? "true" : undefined}
						onScroll={(event) => setSongScrollTop(event.currentTarget.scrollTop)}
						style={virtualListStyle(songWindow)}
					>
						{visibleResults.map((track, localIndex) => {
							const index = songWindow.startIndex + localIndex;
							const disabled = !isPlayable(track.playableState);
							const liked = isResultLiked?.(track) === true;
							const likeBusy = isResultLikeBusy?.(track) === true;
							const artist = firstArtist(track);
							return (
								<div
									className="search-detail-track"
									data-disabled={disabled ? "true" : "false"}
									key={`${track.provider}:${track.id}:${index}`}
									onClick={() => {
										if (!disabled) playResult(index);
									}}
									role="button"
									tabIndex={disabled ? -1 : 0}
									onKeyDown={(event) => {
										if ((event.key === "Enter" || event.key === " ") && !disabled) {
											event.preventDefault();
											playResult(index);
										}
									}}
								>
									<div className="search-detail-track-index">{String(index + 1).padStart(2, "0")}</div>
									<div className="search-detail-track-main">
										<div className={`search-detail-cover${track.coverUrl ? " has-cover" : ""}`} style={resolvedCoverStyle(track.coverUrl)} />
										<div className="search-detail-track-text">
											<div className="search-detail-track-title">{track.title || "未命名歌曲"}</div>
											<div className="search-detail-track-sub">
												{artist ? (
													<button
														className="search-detail-artist"
														type="button"
														onClick={(event) => {
															event.stopPropagation();
															onArtistSearch(artist, track);
														}}
													>
														{trackArtists(track)}
													</button>
												) : "未知艺人"}
											</div>
										</div>
									</div>
									<div className="search-detail-track-album">
										<span>{track.album || "-"}</span>
										<small>{providerLabel(track.provider)} {formatDurationMs(track.durationMs)}</small>
									</div>
									<div className="search-detail-actions" aria-label="歌曲操作">
										<button
											className="search-detail-action primary icon"
											type="button"
											data-search-detail-play
											title="播放单曲"
											aria-label="播放单曲"
											disabled={disabled}
											onClick={(event) => {
												event.stopPropagation();
												if (!disabled) playResult(index);
											}}
										>
											▶
										</button>
										<button
											className="search-detail-action icon"
											type="button"
											data-search-detail-append
											title="加入播放队列"
											aria-label="加入播放队列"
											onClick={(event) => {
												event.stopPropagation();
												onAppendQueue(track);
											}}
										>
											≡+
										</button>
										<button
											className="search-detail-action icon"
											type="button"
											data-search-detail-next
											title="下一首播放"
											aria-label="下一首播放"
											disabled={disabled}
											onClick={(event) => {
												event.stopPropagation();
												if (!disabled) onResultNext(track);
											}}
										>
											↦
										</button>
										<button
											className={`search-detail-action icon${liked ? " liked" : ""}${likeBusy ? " busy" : ""}`}
											type="button"
											title={liked ? "取消红心" : "红心喜欢"}
											aria-label={liked ? "取消红心" : "红心喜欢"}
											disabled={likeBusy}
											onClick={(event) => {
												event.stopPropagation();
												onResultLike(track);
											}}
										>
											♥
										</button>
										<button
											className="search-detail-action icon"
											type="button"
											title="收藏到歌单"
											aria-label="收藏到歌单"
											onClick={(event) => {
												event.stopPropagation();
												onResultCollect(track);
											}}
										>
											+
										</button>
									</div>
								</div>
							);
						})}
					</div>
				) : null}
				{mode === "podcast" && !selectedPodcast && podcasts.length ? (
					<div
						className="search-detail-list search-detail-podcast-list"
						data-virtualized={podcastWindow.virtualized ? "true" : undefined}
						onScroll={(event) => setPodcastScrollTop(event.currentTarget.scrollTop)}
						style={virtualListStyle(podcastWindow)}
					>
						{visiblePodcasts.map((podcast, localIndex) => {
							const index = podcastWindow.startIndex + localIndex;
							return (
								<button
									className="search-detail-podcast-row"
									type="button"
									data-search-detail-podcast={podcast.id || podcast.rid}
									key={`${podcast.id || podcast.rid}:${index}`}
									onClick={() => void openPodcastPrograms(podcast)}
								>
									<div className="search-detail-track-index">{String(index + 1).padStart(2, "0")}</div>
									<div className={`search-detail-cover${podcast.coverUrl ? " has-cover" : ""}`} style={resolvedCoverStyle(podcast.coverUrl)} />
									<div className="search-detail-track-text">
										<div className="search-detail-track-title">{podcast.name}</div>
										<div className="search-detail-track-sub">{podcast.djName || podcast.category || `${podcast.programCount || 0} 期`}</div>
									</div>
								</button>
							);
						})}
					</div>
				) : null}
				{mode === "podcast" && selectedPodcast && programs.length ? (
					<div
						className="search-detail-list"
						data-virtualized={programWindow.virtualized ? "true" : undefined}
						onScroll={(event) => setProgramScrollTop(event.currentTarget.scrollTop)}
						style={virtualListStyle(programWindow)}
					>
						{visiblePrograms.map((program, localIndex) => {
							const index = programWindow.startIndex + localIndex;
							const disabled = !isPlayable(program.playableState);
							return (
								<div
									className="search-detail-track"
									data-search-detail-program={program.programId || program.id}
									data-disabled={disabled ? "true" : "false"}
									key={`${program.provider}:${program.id}:${index}`}
									onClick={() => {
										if (!disabled) playProgram(index);
									}}
									role="button"
									tabIndex={disabled ? -1 : 0}
								>
									<div className="search-detail-track-index">{String(index + 1).padStart(2, "0")}</div>
									<div className="search-detail-track-main">
										<div className={`search-detail-cover${program.coverUrl ? " has-cover" : ""}`} style={resolvedCoverStyle(program.coverUrl)} />
										<div className="search-detail-track-text">
											<div className="search-detail-track-title">{program.title}</div>
											<div className="search-detail-track-sub">{program.radioName || program.djName || "Podcast"}</div>
										</div>
									</div>
									<div className="search-detail-track-album">
										<span>{program.album || selectedPodcast.name || "-"}</span>
										<small>{formatDurationMs(program.durationMs)}</small>
									</div>
									<div className="search-detail-actions" aria-label="播客节目操作">
										<button
											className="search-detail-action primary icon"
											type="button"
											data-search-detail-play
											title="播放单曲"
											aria-label="播放单曲"
											disabled={disabled}
											onClick={(event) => {
												event.stopPropagation();
												if (!disabled) playProgram(index);
											}}
										>
											▶
										</button>
										<button
											className="search-detail-action icon"
											type="button"
											data-search-detail-append
											title="加入播放队列"
											aria-label="加入播放队列"
											onClick={(event) => {
												event.stopPropagation();
												onAppendQueue(program);
											}}
										>
											≡+
										</button>
										<button
											className="search-detail-action icon"
											type="button"
											data-search-detail-next
											title="下一首播放"
											aria-label="下一首播放"
											disabled={disabled}
											onClick={(event) => {
												event.stopPropagation();
												if (!disabled) onResultNext(program);
											}}
										>
											↦
										</button>
									</div>
								</div>
							);
						})}
					</div>
				) : null}
				{canLoadNext ? (
					<button
						className="search-detail-state search-load-more"
						type="button"
						data-search-detail-load-more
						disabled={loadingNext}
						onClick={() => void searchSessionController.loadNext()}
					>
						{loadingNext ? "加载中..." : "加载更多"}
					</button>
				) : null}
			</div>
		</section>
	);
}
