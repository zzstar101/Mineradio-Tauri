import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from "react";
import type { PodcastRadio, Track } from "@mineradio/shared";
import type { SearchExperiencePort } from "../../ports/music/search-port";
import { isPlayable, playSearchResult } from "../search/play-search-result";
import { isSharedPlaylistCandidateText } from "../../shared-playlist/imported-playlists";
import { useSearchStore, type SearchMode } from "../../stores/search-store";
import { searchSessionController } from "../../features/search/search-session-runtime";
import { resolveVirtualListWindow, type VirtualListWindow } from "./virtual-list";
import { coverSourceToCssBackgroundImage, useCoverSourceResolver } from "../../cover/resolved-cover-source";

export type { SearchMode } from "../../stores/search-store";

export interface SearchShellProps {
	client: SearchExperiencePort | null;
	onFocus?: () => void;
	onUpload?: () => void;
	onUploadFolder?: () => void;
	onClearCustomCover?: () => void;
	onResultPlay?: (track: Track) => void;
	onResultNext?: (track: Track) => void;
	onResultLike?: (track: Track) => void;
	onResultCollect?: (track: Track) => void;
	onSharedPlaylistImport?: (text: string) => Promise<void> | void;
	onArtistSearch?: (artist: string, track: Track) => void;
	isResultLiked?: (track: Track) => boolean;
	isResultLikeBusy?: (track: Track) => boolean;
	hasCustomCover?: boolean;
	peek?: boolean;
	requestedMode?: SearchMode;
}

const SEARCH_RESULT_ROW_HEIGHT = 58;
const SEARCH_RESULT_VIEWPORT_HEIGHT = 348;
const SEARCH_RESULT_VIRTUAL_THRESHOLD = 80;

function isPodcastTrack(track: Track): boolean {
	const candidate = track as Track & { type?: string; programId?: string; radioId?: string };
	return candidate.type === "podcast" || !!candidate.programId || !!candidate.radioId;
}

function trackArtists(track: Track): string {
	return track.artists.length > 0 ? track.artists.join(" / ") : "未知艺人";
}

function virtualListStyle(window: VirtualListWindow): CSSProperties | undefined {
	return window.virtualized
		? {
			maxHeight: SEARCH_RESULT_VIEWPORT_HEIGHT,
			overflowY: "auto",
			paddingTop: window.paddingTop,
			paddingBottom: window.paddingBottom,
		}
		: undefined;
}

function HeartIcon(): ReactElement {
	return (
		<svg className="heart-svg" viewBox="0 0 24 24" aria-hidden="true">
			<path d="M12 21.45c-.32 0-.62-.12-.86-.34l-1.23-1.12C5.54 16.03 2.25 13.05 2.25 8.9 2.25 5.48 4.88 2.9 8.28 2.9c1.7 0 3.35.72 4.52 1.96C13.97 3.62 15.62 2.9 17.32 2.9c3.4 0 6.03 2.58 6.03 6 0 4.15-3.29 7.13-7.66 11.09l-1.23 1.12c-.24.22-.54.34-.86.34z" />
		</svg>
	);
}

function CollectIcon(): ReactElement {
	return (
		<svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
			<path d="M12 5v14" />
			<path d="M5 12h14" />
		</svg>
	);
}

export function SearchShell({
	client,
	onFocus,
	onUpload,
	onUploadFolder,
	onClearCustomCover,
	onResultPlay,
	onResultNext,
	onResultLike,
	onResultCollect,
	onSharedPlaylistImport,
	onArtistSearch,
	isResultLiked,
	isResultLikeBusy,
	hasCustomCover = false,
	peek = false,
	requestedMode,
}: SearchShellProps): ReactElement {
	const resolveCover = useCoverSourceResolver();
	const provider = useSearchStore((s) => s.provider);
	const keyword = useSearchStore((s) => s.keyword);
	const mode = useSearchStore((s) => s.mode);
	const results = useSearchStore((s) => s.results);
	const podcastResults = useSearchStore((s) => s.podcasts);
	const podcastPrograms = useSearchStore((s) => s.programs);
	const podcastCurrentRadio = useSearchStore((s) => s.selectedPodcast);
	const loading = useSearchStore((s) => s.loading);
	const loadingNext = useSearchStore((s) => s.loadingNext);
	const error = useSearchStore((s) => s.error);
	const exhausted = useSearchStore((s) => s.exhausted);
	const visibleCount = useSearchStore((s) => s.visibleCount);
	const recentQueries = useSearchStore((s) => s.recentQueries);
	const [songResultScrollTop, setSongResultScrollTop] = useState(0);
	const [podcastResultScrollTop, setPodcastResultScrollTop] = useState(0);
	const [podcastProgramScrollTop, setPodcastProgramScrollTop] = useState(0);
	const [surfaceNotice, setSurfaceNotice] = useState<string | null>(null);
	const requestedModeRef = useRef<SearchMode | undefined>(undefined);
	const controller = searchSessionController;

	const runSearch = useCallback(
		async (nextKeyword: string, nextMode: SearchMode = mode) => {
			controller.setPort(client);
			const trimmed = nextKeyword.trim();
			setSongResultScrollTop(0);
			setPodcastResultScrollTop(0);
			setPodcastProgramScrollTop(0);
			if (isSharedPlaylistCandidateText(trimmed)) {
				await controller.importSharedPlaylist(
					nextKeyword,
					nextMode,
					async (value) => {
						if (!onSharedPlaylistImport) {
							throw new Error("当前版本暂不支持导入歌单链接");
						}
						await onSharedPlaylistImport(value);
					},
				);
				return;
			}
			await controller.search(nextKeyword, nextMode);
		},
		[client, controller, mode, onSharedPlaylistImport],
	);

	useEffect(() => {
		if (!keyword.trim() && mode !== "podcast") {
			controller.clear(false);
			return;
		}
		const timer = setTimeout(() => {
			void runSearch(keyword, mode);
		}, 180);
		return () => clearTimeout(timer);
	}, [keyword, mode, runSearch]);

	useEffect(() => {
		if (!requestedMode || requestedModeRef.current === requestedMode) return;
		requestedModeRef.current = requestedMode;
		controller.setPort(client);
		void controller.search(keyword, requestedMode);
	}, [client, controller, keyword, requestedMode]);

	const selectMode = (nextMode: SearchMode) => {
		setSongResultScrollTop(0);
		setPodcastResultScrollTop(0);
		setPodcastProgramScrollTop(0);
		void runSearch(keyword, nextMode);
	};

	const submit = () => {
		controller.setPort(client);
		void controller.openDetail(keyword, mode);
	};

	const playResult = (track: Track) => {
		playSearchResult(track);
		controller.clear(false, isPodcastTrack(track) ? "song" : undefined);
		onResultPlay?.(track);
	};

	const openPodcastPrograms = async (radio: PodcastRadio) => {
		setPodcastProgramScrollTop(0);
		controller.setPort(client);
		await controller.openPodcastPrograms(radio);
	};

	const backToPodcastRadios = () => {
		controller.backToPodcastResults();
	};

	const openArtist = (track: Track) => {
		const artist = track.artists.find((name) => name.trim().length > 0)?.trim();
		if (!artist) return;
		onArtistSearch?.(artist, track);
	};

	const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			submit();
		}
		if (event.key === "Escape") {
			controller.clear(false);
		}
	};

	const showResults = results.length > 0 || podcastResults.length > 0 || podcastPrograms.length > 0 || !!error || loading || keyword.trim().length > 0 || mode === "podcast";
	const effectivePeek = peek || showResults;
	const searchAreaClassName = [
		effectivePeek ? "peek" : "",
		showResults ? "has-results" : "",
	].filter(Boolean).join(" ");
	const displayedResults = results.slice(0, visibleCount);
	const displayedPodcasts = podcastResults.slice(0, visibleCount);
	const displayedPrograms = podcastPrograms.slice(0, visibleCount);
	const songResultWindow = resolveVirtualListWindow({
		itemCount: displayedResults.length,
		rowHeight: SEARCH_RESULT_ROW_HEIGHT,
		viewportHeight: SEARCH_RESULT_VIEWPORT_HEIGHT,
		scrollTop: songResultScrollTop,
		threshold: SEARCH_RESULT_VIRTUAL_THRESHOLD,
	});
	const visibleSongResults = displayedResults.slice(songResultWindow.startIndex, songResultWindow.endIndex);
	const podcastResultWindow = resolveVirtualListWindow({
		itemCount: displayedPodcasts.length,
		rowHeight: SEARCH_RESULT_ROW_HEIGHT,
		viewportHeight: SEARCH_RESULT_VIEWPORT_HEIGHT,
		scrollTop: podcastResultScrollTop,
		threshold: SEARCH_RESULT_VIRTUAL_THRESHOLD,
	});
	const visiblePodcastResults = displayedPodcasts.slice(podcastResultWindow.startIndex, podcastResultWindow.endIndex);
	const podcastProgramWindow = resolveVirtualListWindow({
		itemCount: displayedPrograms.length,
		rowHeight: SEARCH_RESULT_ROW_HEIGHT,
		viewportHeight: SEARCH_RESULT_VIEWPORT_HEIGHT,
		scrollTop: podcastProgramScrollTop,
		threshold: SEARCH_RESULT_VIRTUAL_THRESHOLD,
	});
	const visiblePodcastPrograms = displayedPrograms.slice(podcastProgramWindow.startIndex, podcastProgramWindow.endIndex);
	const activeItemCount = mode === "podcast"
		? podcastCurrentRadio ? podcastPrograms.length : podcastResults.length
		: results.length;
	const canLoadNext = visibleCount < activeItemCount || !exhausted;

	return (
		<div id="search-area" className={searchAreaClassName} data-shell="home-search">
			<div id="search-stack">
				<div id="search-box">
					<svg id="search-icon" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
						<circle cx="11" cy="11" r="7" />
						<path d="m20 20-3.5-3.5" />
					</svg>
					<input
						id="search-input"
						type="text"
						placeholder="搜索歌曲、歌手..."
						aria-label="搜索歌曲、歌手、播客"
						autoComplete="off"
						spellCheck={false}
						value={keyword}
						onChange={(event) => controller.updateDraft(event.target.value)}
						onFocus={onFocus}
						onKeyDown={onInputKeyDown}
					/>
				</div>
				<div id="search-mode-tabs" className="search-mode-tabs" role="tablist" aria-label="Search mode">
					<button id="search-mode-song" className={mode === "song" ? "active" : ""} type="button" aria-selected={mode === "song"} onClick={() => selectMode("song")}>All</button>
					<button id="search-mode-netease" className={mode === "netease" ? "active" : ""} type="button" aria-selected={mode === "netease"} onClick={() => selectMode("netease")}>NE</button>
					<button id="search-mode-qq" className={mode === "qq" ? "active" : ""} type="button" aria-selected={mode === "qq"} onClick={() => selectMode("qq")}>QQ</button>
					<button id="search-mode-podcast" className={mode === "podcast" ? "active" : ""} type="button" aria-selected={mode === "podcast"} onClick={() => selectMode("podcast")}>Podcast</button>
				</div>
				<div id="search-results" className={showResults ? "show" : ""} aria-live="polite">
					{!showResults && recentQueries.length > 0 ? (
						<div className="search-history">
							<div className="search-history-head">
								<span>搜索历史</span>
								<button className="search-history-clear" type="button" onClick={() => void controller.clearHistory()}>清空</button>
							</div>
							<div className="search-history-list">
								{recentQueries.map((item) => (
									<span key={item.keyword.toLocaleLowerCase()}>
										<button className="search-history-chip" type="button" onClick={() => void runSearch(item.keyword, mode)}>{item.keyword}</button>
										<button className="search-history-remove" type="button" aria-label={`删除历史 ${item.keyword}`} onClick={() => void controller.removeHistory(item.keyword)}>×</button>
									</span>
								))}
							</div>
						</div>
					) : null}
					{loading ? <div className="search-shell-state">搜索中...</div> : null}
					{error ? <div className="search-shell-error">{error}</div> : null}
					{!loading && !error && showResults && results.length === 0 && podcastResults.length === 0 && podcastPrograms.length === 0 ? (
						<div className="search-shell-state">没有找到结果</div>
					) : null}
					{podcastCurrentRadio ? (
						<div className="podcast-result-head">
							<button className="podcast-back-btn" type="button" aria-label="返回播客列表" onClick={backToPodcastRadios}>‹</button>
							{resolveCover(podcastCurrentRadio.coverUrl).uri ? <img src={resolveCover(podcastCurrentRadio.coverUrl).uri} alt="" /> : <div className="search-result-cover-placeholder" />}
							<div className="search-result-info">
								<div className="search-result-title">{podcastCurrentRadio.name || "Podcast"}<span className="tag-podcast">Podcast</span></div>
								<div className="search-result-meta">{podcastCurrentRadio.djName || (podcastPrograms.length ? `${podcastPrograms.length} episodes` : "No playable episodes")}</div>
							</div>
						</div>
					) : null}
					{podcastPrograms.length > 0 ? (
						<ul
							className="search-shell-list search-shell-podcast-program-list"
							data-virtualized={podcastProgramWindow.virtualized ? "true" : undefined}
							onScroll={(event) => setPodcastProgramScrollTop(event.currentTarget.scrollTop)}
							style={virtualListStyle(podcastProgramWindow)}
						>
							{visiblePodcastPrograms.map((program, localIndex) => (
								<li key={`${program.provider}-${program.id}-${program.programId}-${podcastProgramWindow.startIndex + localIndex}`} className="search-shell-row">
									<button
										type="button"
										className="search-shell-row-btn"
										data-podcast-program-id={program.programId || program.id}
										onClick={() => playResult(program)}
									>
										<span className="search-shell-cover" style={resolveCover(program.coverUrl).uri ? { backgroundImage: coverSourceToCssBackgroundImage(resolveCover(program.coverUrl).uri) } : undefined} />
										<span className="search-shell-meta">
											<span className="search-shell-title">{program.title}</span>
											<span className="search-shell-sub">{program.radioName || program.album || program.djName || "Podcast"}</span>
										</span>
									</button>
									<div className="search-shell-actions" aria-label="播客节目操作">
										<button
											type="button"
											className="search-shell-action add-btn search-shell-next"
											title="下一首播放"
											aria-label="下一首播放"
											onClick={(event) => {
												event.stopPropagation();
												onResultNext?.(program);
											}}
										>
											+
										</button>
									</div>
								</li>
							))}
						</ul>
					) : null}
					{podcastResults.length > 0 && !podcastCurrentRadio ? (
						<ul
							className="search-shell-list search-shell-podcast-list"
							data-virtualized={podcastResultWindow.virtualized ? "true" : undefined}
							onScroll={(event) => setPodcastResultScrollTop(event.currentTarget.scrollTop)}
							style={virtualListStyle(podcastResultWindow)}
						>
							{visiblePodcastResults.map((radio) => (
								<li key={radio.id || radio.rid}>
									<button
										type="button"
										className="search-result podcast-result"
										data-podcast-id={radio.id || radio.rid}
										onClick={() => {
											void openPodcastPrograms(radio);
										}}
									>
										{resolveCover(radio.coverUrl).uri ? <img src={resolveCover(radio.coverUrl).uri} alt="" /> : <div className="search-result-cover-placeholder" />}
										<div className="search-result-info">
											<div className="search-result-title">{radio.name}<span className="tag-podcast">Podcast</span></div>
											<div className="search-result-meta">{radio.djName || radio.category || `${radio.programCount || 0} episodes`}</div>
										</div>
									</button>
								</li>
							))}
						</ul>
					) : null}
					{results.length > 0 ? (
						<ul
							className="search-shell-list"
							data-virtualized={songResultWindow.virtualized ? "true" : undefined}
							onScroll={(event) => setSongResultScrollTop(event.currentTarget.scrollTop)}
							style={virtualListStyle(songResultWindow)}
						>
							{visibleSongResults.map((track, localIndex) => {
								const index = songResultWindow.startIndex + localIndex;
								const disabled = !isPlayable(track.playableState);
								const liked = isResultLiked?.(track) === true;
								const likeBusy = isResultLikeBusy?.(track) === true;
								return (
									<li key={`${track.provider}-${track.id}-${index}`} className="search-shell-row" data-disabled={disabled ? "true" : "false"}>
										<div className="search-shell-main">
											<button
												type="button"
												className="search-shell-row-btn"
												disabled={disabled}
												onClick={() => {
													if (!disabled) playResult(track);
												}}
											>
												<span className="search-shell-cover" style={resolveCover(track.coverUrl).uri ? { backgroundImage: coverSourceToCssBackgroundImage(resolveCover(track.coverUrl).uri) } : undefined} />
												<span className="search-shell-meta">
													<span className="search-shell-title">{track.title}</span>
												</span>
												<span className="search-shell-provider">{track.provider === provider ? track.provider : track.provider.toUpperCase()}</span>
											</button>
											<button
												type="button"
												className="search-shell-sub search-artist-link"
												onClick={(event) => {
													event.stopPropagation();
													openArtist(track);
												}}
											>
												{trackArtists(track)}
											</button>
										</div>
										<div className="search-shell-actions" aria-label="歌曲操作">
											<button
												type="button"
												className={`search-shell-action song-action-btn search-shell-like${liked ? " liked" : ""}${likeBusy ? " busy" : ""}`}
												title={liked ? "取消红心" : "红心喜欢"}
												aria-label={liked ? "取消红心" : "红心喜欢"}
												disabled={likeBusy}
												onClick={(event) => {
													event.stopPropagation();
													onResultLike?.(track);
												}}
											>
												<HeartIcon />
											</button>
											<button
												type="button"
												className="search-shell-action song-action-btn search-shell-collect"
												title="收藏到歌单"
												aria-label="收藏到歌单"
												onClick={(event) => {
													event.stopPropagation();
													onResultCollect?.(track);
												}}
											>
												<CollectIcon />
											</button>
											<button
												type="button"
												className="search-shell-action add-btn search-shell-next"
												title="下一首播放"
												aria-label="下一首播放"
												disabled={disabled}
												onClick={(event) => {
													event.stopPropagation();
													if (!disabled) onResultNext?.(track);
												}}
											>
												+
											</button>
										</div>
									</li>
								);
							})}
						</ul>
					) : null}
					{canLoadNext ? (
						<button
							className="search-shell-state search-load-more"
							type="button"
							data-search-load-more
							disabled={loadingNext}
							onClick={() => void searchSessionController.loadNext()}
						>
							{loadingNext ? "加载中..." : "加载更多"}
						</button>
					) : null}
				</div>
			</div>
			<div id="upload-actions">
				<button id="upload-btn" className="icon-btn" type="button" title="导入音乐或封面" aria-label="导入音乐或封面" onClick={onUpload}>
					<svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
						<polyline points="17 8 12 3 7 8" />
						<line x1="12" y1="3" x2="12" y2="15" />
					</svg>
				</button>
				{onUploadFolder ? (
					<button
						id="upload-folder-btn"
						className="icon-btn"
						type="button"
						title="导入本地文件夹"
						aria-label="导入本地文件夹"
						onClick={onUploadFolder}
					>
						<svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
						</svg>
					</button>
				) : null}
				<button
					id="clear-cover-btn"
					className={hasCustomCover ? "icon-btn has-cover" : "icon-btn"}
					type="button"
					title={hasCustomCover ? "取消自定义封面" : "当前没有自定义封面"}
					aria-label={hasCustomCover ? "取消自定义封面" : "当前没有自定义封面"}
					onClick={() => {
						if (hasCustomCover) onClearCustomCover?.();
						else setSurfaceNotice("当前没有自定义封面");
					}}
				>×</button>
				<div id="upload-tip" className={surfaceNotice ? "show" : undefined} role="status" aria-live="polite">
					<button className="upload-tip-close" type="button" aria-label="关闭提示" onClick={() => setSurfaceNotice(null)}>×</button>
					<span className="upload-tip-title">导入入口</span>
					{surfaceNotice ?? "这里支持上传歌曲，也可以给当前曲目换自定义封面。"}
				</div>
			</div>
		</div>
	);
}
