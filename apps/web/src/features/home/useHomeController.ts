import { useCallback, useEffect, useRef, useState } from "react";
import type {
	DiscoverHomeResponse,
	ProviderId,
	RecommendationCard as RecommendationCardData,
	RecommendationPage,
	Track,
	WeatherRadioResponse,
} from "@mineradio/shared";
import type { DiscoverPort } from "../../ports/music/discover-port";
import { usePlaybackStore } from "../../stores/playback-store";
import type { LibraryPort } from "../../ports/music/library-port";
import type { SearchExperiencePort } from "../../ports/music/search-port";
import type { HomePlaylistDetailView } from "../../home/EmptyHomeHost";
import {
	buildTrackFromRecommendationCard,
	type RecommendationDetail,
} from "../recommendation/recommendation-page-policy";
import {
	shouldUseCachedHomeDiscoverPlaylist,
} from "./home-policy";
import type { HomeDashboardModel } from "./home-dashboard-policy";
import type { HomeListenSummary } from "./home-listen-ledger";
import type { HomeListenRepository } from "./home-listen-repository";
import { defaultHomeListenRepository } from "./legacy-home-listen-adapter";
import {
	HOME_PLAYLIST_PAGE_SIZE,
	applyPlaylistPageAtOffset,
	playlistHasNextPage,
} from "./home-playlist-paging";
import {
	useHomeDashboardController,
	type HomeDashboardPlaybackFacade,
} from "./useHomeDashboardController";
import { useHomeListenLedger } from "./useHomeListenLedger";

export type HomeListenStorage = HomeListenRepository;

export interface HomeControllerResult {
	discover: DiscoverHomeResponse | null;
	recommendations: RecommendationPage[];
	weatherRadio: WeatherRadioResponse | null;
	playlistDetail: HomePlaylistDetailView | null;
	recommendationDetail: RecommendationDetail | null;
	discoverLoading: boolean;
	recommendationsLoading: boolean;
	weatherRadioLoading: boolean;
	discoverError: string | null;
	recommendationsError: string | null;
	weatherRadioError: string | null;
	forcedOpen: boolean;
	suppressed: boolean;
	listenSummary: HomeListenSummary | null;
	dashboard: HomeDashboardModel;
	setForcedOpen(open: boolean): void;
	setSuppressed(suppressed: boolean): void;
	refreshDiscover(): Promise<DiscoverHomeResponse | null>;
	refreshRecommendations(options?: { refresh?: boolean }): Promise<RecommendationPage[]>;
	refreshWeatherRadio(): Promise<WeatherRadioResponse | null>;
	recordListenPause(): void;
	recordListenProgress(positionMs: number, durationMs: number | null): void;
	finalizeListenSession(completed?: boolean): void;
	playDaily(): void;
	playPrivate(): Promise<void>;
	playDiscoverSongs(index: number): Promise<void>;
	openPlaylist(index: number): Promise<void>;
	closePlaylistDetail(): void;
	playPlaylistDetail(index: number): void;
	loadMorePlaylistTracks(): Promise<void>;
	openRecommendations(anchorProvider: ProviderId): void;
	closeRecommendations(): void;
	playRecommendationTrack(provider: ProviderId, card: RecommendationCardData): void;
	playRecommendationStream(provider: ProviderId, card: RecommendationCardData): Promise<void>;
	openRecommendationPlaylist(provider: ProviderId, id: string): Promise<void>;
	searchPlaylistDetailArtist(artist: string): void;
	openPodcast(index: number): Promise<void>;
	openPodcastSearch(): void;
	playWeatherSong(index: number): Promise<void>;
	openInsight(): void;
	playRecent(): void;
	continueListening(): void;
	playNextUp(): void;
	playForYou(index: number): void;
	enterPlaybackSurface(): void;
}

export function useHomeController({
	discover: discoverPort,
	library,
	search,
	currentTrack,
	positionMs,
	durationMs,
	queue,
	currentQueueIndex,
	isPlaying,
	playbackMode,
	providerLoggedIn,
	libraryPanelPinned,
	playback,
	searchQuery,
	openLogin,
	openLibrarySurface,
	enterPlaybackSurface,
	closeLibraryPanel,
	closeShelf,
	selectShelfPlaylist,
	setConsole,
	setMiniQueue,
	showToast,
	storage = defaultHomeListenRepository,
	autoRefresh = true,
}: {
	discover: DiscoverPort | null;
	library: LibraryPort | null;
	search: SearchExperiencePort | null;
	currentTrack: Track | null;
	positionMs: number;
	durationMs: number | null;
	queue?: Track[];
	currentQueueIndex?: number;
	isPlaying?: boolean;
	playbackMode?: "single" | "loop" | "queue" | "shuffle";
	providerLoggedIn: boolean | (() => boolean);
	libraryPanelPinned: boolean;
	playback: HomeDashboardPlaybackFacade;
	searchQuery(keyword: string, mode?: "song" | "podcast"): void;
	openLogin(): void;
	openLibrarySurface(): void;
	enterPlaybackSurface(): void;
	closeLibraryPanel(): void;
	closeShelf(): void;
	selectShelfPlaylist(id: string | null): void;
	setConsole(open: boolean): void;
	setMiniQueue(open: boolean): void;
	showToast(message: string): void;
	storage?: HomeListenStorage;
	autoRefresh?: boolean;
}): HomeControllerResult {
	const [discover, setDiscover] = useState<DiscoverHomeResponse | null>(null);
	const [recommendations, setRecommendations] = useState<RecommendationPage[]>([]);
	const [weatherRadio, setWeatherRadio] = useState<WeatherRadioResponse | null>(
		null,
	);
	const [playlistDetail, setPlaylistDetail] =
		useState<HomePlaylistDetailView | null>(null);
	const [recommendationDetail, setRecommendationDetail] =
		useState<RecommendationDetail | null>(null);
	const [discoverLoading, setDiscoverLoading] = useState(false);
	const [recommendationsLoading, setRecommendationsLoading] = useState(false);
	const [weatherRadioLoading, setWeatherRadioLoading] = useState(false);
	const [discoverError, setDiscoverError] = useState<string | null>(null);
	const [recommendationsError, setRecommendationsError] = useState<string | null>(null);
	const [weatherRadioError, setWeatherRadioError] = useState<string | null>(null);
	const [forcedOpen, setForcedOpen] = useState(false);
	const [suppressed, setSuppressed] = useState(false);
	const {
		summary: listenSummary,
		recordPause: recordListenPause,
		recordProgress: recordListenProgress,
		finalize: finalizeListenSession,
	} = useHomeListenLedger({
		currentTrack,
		positionMs,
		durationMs,
		repository: storage,
	});
	const discoverRequestRef = useRef(0);
	const recommendationRequestRef = useRef(0);
	const weatherRequestRef = useRef(0);
	const dependenciesRef = useRef({
		discoverPort,
		library,
		search,
		providerLoggedIn,
		libraryPanelPinned,
		playback,
		searchQuery,
		openLogin,
		openLibrarySurface,
		enterPlaybackSurface,
		closeLibraryPanel,
		closeShelf,
		selectShelfPlaylist,
		setConsole,
		setMiniQueue,
		showToast,
		storage,
	});
	dependenciesRef.current = {
		discoverPort,
		library,
		search,
		providerLoggedIn,
		libraryPanelPinned,
		playback,
		searchQuery,
		openLogin,
		openLibrarySurface,
		enterPlaybackSurface,
		closeLibraryPanel,
		closeShelf,
		selectShelfPlaylist,
		setConsole,
		setMiniQueue,
		showToast,
		storage,
	};
	const hasProviderLogin = useCallback(() => {
		const value = dependenciesRef.current.providerLoggedIn;
		return typeof value === "function" ? value() : value;
	}, []);

	const refreshDiscover = useCallback(async () => {
		const port = dependenciesRef.current.discoverPort;
		if (!port) {
			setDiscover(null);
			setDiscoverLoading(false);
			setDiscoverError(null);
			return null;
		}
		const sequence = ++discoverRequestRef.current;
		setDiscoverLoading(true);
		setDiscoverError(null);
		try {
			const next = await port.discoverHome();
			if (sequence === discoverRequestRef.current) setDiscover(next);
			return next;
		} catch (error) {
			const fallback: DiscoverHomeResponse = {
				loggedIn: false,
				user: null,
				dailySongs: [],
				playlists: [],
				podcasts: [],
				mode: "starter",
				updatedAt: Date.now(),
			};
			if (sequence === discoverRequestRef.current) {
				setDiscover((current) => current ?? fallback);
				setDiscoverError(
					error instanceof Error ? error.message : "首页推荐载入失败",
				);
			}
			return fallback;
		} finally {
			if (sequence === discoverRequestRef.current) setDiscoverLoading(false);
		}
	}, []);

	const refreshRecommendations = useCallback(async (
		options: { refresh?: boolean } = {},
	) => {
		const port = dependenciesRef.current.discoverPort;
		if (!port) {
			setRecommendations([]);
			setRecommendationsLoading(false);
			setRecommendationsError(null);
			return [];
		}
		const sequence = ++recommendationRequestRef.current;
		setRecommendationsLoading(true);
		setRecommendationsError(null);
		try {
			const next = await port.recommendationPages(options);
			if (sequence === recommendationRequestRef.current) setRecommendations(next);
			return next;
		} catch (error) {
			if (sequence === recommendationRequestRef.current) {
				setRecommendationsError(
					error instanceof Error ? error.message : "推荐内容载入失败",
				);
			}
			return [];
		} finally {
			if (sequence === recommendationRequestRef.current) {
				setRecommendationsLoading(false);
			}
		}
	}, []);

	const refreshWeatherRadio = useCallback(async () => {
		const port = dependenciesRef.current.discoverPort;
		if (!port) {
			setWeatherRadio(null);
			setWeatherRadioLoading(false);
			setWeatherRadioError(null);
			return null;
		}
		const sequence = ++weatherRequestRef.current;
		setWeatherRadioLoading(true);
		setWeatherRadioError(null);
		try {
			const next = await port.weatherRadio({
				city: "上海",
				timezone:
					typeof Intl !== "undefined"
						? Intl.DateTimeFormat().resolvedOptions().timeZone || "auto"
						: "auto",
			});
			if (sequence === weatherRequestRef.current) setWeatherRadio(next);
			return next;
		} catch (error) {
			if (sequence === weatherRequestRef.current) {
				setWeatherRadioError(
					error instanceof Error ? error.message : "天气电台载入失败",
				);
			}
			return null;
		} finally {
			if (sequence === weatherRequestRef.current) setWeatherRadioLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!autoRefresh) return;
		if (!discoverPort) {
			setDiscover(null);
			setRecommendations([]);
			setWeatherRadio(null);
			setDiscoverLoading(false);
			setRecommendationsLoading(false);
			setWeatherRadioLoading(false);
			setDiscoverError(null);
			setRecommendationsError(null);
			setWeatherRadioError(null);
			return;
		}
		void refreshDiscover();
		void refreshRecommendations();
		void refreshWeatherRadio();
	}, [
		autoRefresh,
		discoverPort,
		typeof providerLoggedIn === "boolean" ? providerLoggedIn : false,
		refreshRecommendations,
		refreshDiscover,
		refreshWeatherRadio,
	]);

	const hasLogin = useCallback(
		() => discover?.loggedIn || hasProviderLogin(),
		[discover?.loggedIn, hasProviderLogin],
	);

	const enterPlayback = useCallback(() => {
		setPlaylistDetail(null);
		setForcedOpen(false);
		setSuppressed(true);
		dependenciesRef.current.enterPlaybackSurface();
	}, []);

	const {
		model: dashboard,
		continueListening,
		playNextUp,
		playForYou,
	} = useHomeDashboardController({
		discover,
		listenSummary,
		queue,
		currentIndex: currentQueueIndex,
		currentTrack,
		isPlaying,
		playbackMode,
		playback,
		enterPlayback,
		showToast,
	});

	const playDiscoverSongs = useCallback(
		async (index: number) => {
			const current = dependenciesRef.current;
			const nextDiscover = discover?.loggedIn ? discover : await refreshDiscover();
			if (!hasLogin() && !nextDiscover?.loggedIn) {
				current.openLogin();
				current.showToast("登录后同步你的今日歌曲");
				return;
			}
			const songs = nextDiscover?.dailySongs ?? [];
			const targetIndex = Math.max(0, Math.min(index, songs.length - 1));
			if (!songs.length || !songs[targetIndex]) {
				current.searchQuery(index > 0 ? "私人雷达" : "每日推荐", "song");
				return;
			}
			current.playback.setQueue(songs);
			current.playback.playAt(targetIndex);
			enterPlayback();
		},
		[discover, enterPlayback, hasLogin, refreshDiscover],
	);

	const playDaily = useCallback(() => {
		void playDiscoverSongs(0);
	}, [playDiscoverSongs]);

	const openPlaylist = useCallback(
		async (index: number) => {
			const current = dependenciesRef.current;
			const useCached = shouldUseCachedHomeDiscoverPlaylist(
				discover,
				hasProviderLogin(),
			);
			const nextDiscover = useCached ? discover : await refreshDiscover();
			const item = nextDiscover?.playlists[index];
			if (!item) {
				if (!hasLogin() && !nextDiscover?.loggedIn) current.searchQuery("", "song");
				else current.openLibrarySurface();
				return;
			}
			if (!current.library) {
				current.showToast("API 未就绪，稍后再试");
				return;
			}
			const key = `${item.provider}:${item.id}`;
			setPlaylistDetail({ key, playlist: item, tracks: [], loading: true });
			playlistLoadedCountRef.current = 0;
			setSuppressed(false);
			setForcedOpen(true);
			current.setConsole(false);
			current.setMiniQueue(false);
			if (!current.libraryPanelPinned) current.closeLibraryPanel();
			current.closeShelf();
			current.selectShelfPlaylist(null);
			try {
				const detail = await current.library.playlistDetail(item.provider, item.id, {
					offset: 0,
					limit: HOME_PLAYLIST_PAGE_SIZE,
				});
				playlistLoadedCountRef.current = detail.tracks.length;
				setPlaylistDetail((value) =>
					value?.key === key
						? {
								key,
								playlist: detail,
								tracks: detail.tracks,
								loading: false,
								exhausted: !playlistHasNextPage({
									hasMore: detail.hasMore ?? null,
									loadedCount: detail.tracks.length,
									pageCount: detail.tracks.length,
									pageSize: HOME_PLAYLIST_PAGE_SIZE,
									totalCount: detail.trackCount ?? null,
								}),
							}
						: value,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : "歌单载入失败";
				setPlaylistDetail((value) =>
					value?.key === key
						? { ...value, loading: false, error: message, tracks: [] }
						: value,
				);
				current.showToast(message);
			}
		},
		[discover, hasLogin, hasProviderLogin, refreshDiscover],
	);

	const closePlaylistDetail = useCallback(() => setPlaylistDetail(null), []);

	/** 歌单详情加载下一页：单飞串行（进行中直接忽略新的触发），
	 *  合并时去重；无新增/请求失败都判尽并收起占位。
	 *  已载数以 ref 为权威：快速滚动下旧渲染的闭包可能持有过期 tracks 快照，
	 *  用它算 offset 会发出重复页；提交时再校验一次 offset 是否仍与已载数一致，
	 *  不一致说明响应已过期，丢弃且不判尽（保留占位等下一次触发）。 */
	const playlistLoadMoreBusyRef = useRef(false);
	const playlistLoadedCountRef = useRef(0);
	const loadMorePlaylistTracks = useCallback(async () => {
		const current = dependenciesRef.current;
		const view = playlistDetail;
		if (
			playlistLoadMoreBusyRef.current ||
			!view ||
			view.loading ||
			view.loadingMore ||
			view.exhausted ||
			playlistLoadedCountRef.current === 0 ||
			!current.library
		) {
			return;
		}
		const offset = playlistLoadedCountRef.current;
		const key = view.key;
		playlistLoadMoreBusyRef.current = true;
		setPlaylistDetail((value) =>
			value && value.key === key ? { ...value, loadingMore: true } : value,
		);
		try {
			const page = await current.library.playlistDetail(
				view.playlist.provider,
				view.playlist.id,
				{ offset, limit: HOME_PLAYLIST_PAGE_SIZE },
			);
			setPlaylistDetail((value) => {
				if (!value || (key != null && value.key !== key)) return value;
				if (playlistLoadedCountRef.current !== offset) {
					// 陈旧响应：期间列表已被其他写入推进，丢弃本页（不判尽）
					return { ...value, loadingMore: false };
				}
				const merged = applyPlaylistPageAtOffset(value.tracks, offset, page.tracks);
				playlistLoadedCountRef.current = merged.length;
				return {
					...value,
					tracks: merged,
					loadingMore: false,
					exhausted: !playlistHasNextPage({
						hasMore: page.hasMore ?? null,
						loadedCount: merged.length,
						pageCount: page.tracks.length,
						pageSize: HOME_PLAYLIST_PAGE_SIZE,
						totalCount: value.playlist.trackCount ?? null,
					}),
				};
			});
		} catch {
			// 静默收场：占位消失，用户可再次滚动重试
			setPlaylistDetail((value) =>
				value && value.key === key ? { ...value, loadingMore: false } : value,
			);
		} finally {
			playlistLoadMoreBusyRef.current = false;
		}
	}, [playlistDetail]);

	const closeRecommendations = useCallback(() => setRecommendationDetail(null), []);

	const openRecommendations = useCallback((anchorProvider: ProviderId) => {
		const current = dependenciesRef.current;
		setRecommendationDetail({ anchorProvider });
		setSuppressed(false);
		setForcedOpen(true);
		current.setConsole(false);
		current.setMiniQueue(false);
		if (!current.libraryPanelPinned) current.closeLibraryPanel();
		current.closeShelf();
		current.selectShelfPlaylist(null);
	}, []);

	const playRecommendationTrack = useCallback(
		(provider: ProviderId, card: RecommendationCardData) => {
			const current = dependenciesRef.current;
			const track = buildTrackFromRecommendationCard(provider, card);
			current.playback.setQueue([track]);
			current.playback.playAt(0);
			enterPlayback();
		},
		[enterPlayback],
	);

	/** 流式电台：首拉一首即播并登记 streamSource，
	 *  之后由播放会话 ended 钩子按需续拉生长队列。 */
	const playRecommendationStream = useCallback(
		async (provider: ProviderId, card: RecommendationCardData) => {
			const current = dependenciesRef.current;
			if (!current.library || !discoverPort) {
				current.showToast("API 未就绪，稍后再试");
				return;
			}
			try {
				const track = await discoverPort.streamNext(provider, card.id);
				current.playback.setQueue([track]);
				usePlaybackStore.getState().setStreamSource({ provider, id: card.id });
				current.playback.playAt(0);
				enterPlayback();
				current.showToast("电台已连接");
			} catch {
				current.showToast("流式电台连接失败");
			}
		},
		[discoverPort, enterPlayback],
	);

	/** 打开推荐歌单：与 openPlaylist 同一套详情页/导航样板，
	 *  但按 provider + card.id 定位（不依赖 discover 数组下标）。
	 *  playlist 先放最小占位，playlistDetail 返回后整体替换。 */
	const openRecommendationPlaylist = useCallback(
		async (provider: ProviderId, id: string) => {
			const current = dependenciesRef.current;
			if (!current.library) {
				current.showToast("API 未就绪，稍后再试");
				return;
			}
			const key = `${provider}:${id}`;
			setPlaylistDetail({
				key,
				playlist: { provider, id, name: "", coverUrl: "", trackIds: [], subscribed: false },
				tracks: [],
				loading: true,
			});
			playlistLoadedCountRef.current = 0;
			setSuppressed(false);
			setForcedOpen(true);
			current.setConsole(false);
			current.setMiniQueue(false);
			if (!current.libraryPanelPinned) current.closeLibraryPanel();
			current.closeShelf();
			current.selectShelfPlaylist(null);
			try {
				const detail = await current.library.playlistDetail(provider, id, {
					offset: 0,
					limit: HOME_PLAYLIST_PAGE_SIZE,
				});
				playlistLoadedCountRef.current = detail.tracks.length;
				setPlaylistDetail((value) =>
					value?.key === key
						? {
								key,
								playlist: detail,
								tracks: detail.tracks,
								loading: false,
								exhausted: !playlistHasNextPage({
									hasMore: detail.hasMore ?? null,
									loadedCount: detail.tracks.length,
									pageCount: detail.tracks.length,
									pageSize: HOME_PLAYLIST_PAGE_SIZE,
									totalCount: detail.trackCount ?? null,
								}),
							}
						: value,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : "歌单载入失败";
				setPlaylistDetail((value) =>
					value?.key === key
						? { ...value, loading: false, error: message, tracks: [] }
						: value,
				);
				current.showToast(message);
			}
		},
		[],
	);

	const playPlaylistDetail = useCallback(
		(index: number) => {
			const current = dependenciesRef.current;
			const tracks = playlistDetail?.tracks ?? [];
			if (!playlistDetail || playlistDetail.loading) {
				current.showToast("歌单仍在载入");
				return;
			}
			if (!tracks.length) {
				current.showToast("歌单暂时没有可播放歌曲");
				return;
			}
			const safeIndex = Math.max(0, Math.min(index, tracks.length - 1));
			current.playback.setQueue(tracks);
			current.playback.playAt(safeIndex);
			const title = playlistDetail.playlist.name || "歌单";
			setPlaylistDetail(null);
			enterPlayback();
			current.showToast(title);
		},
		[enterPlayback, playlistDetail],
	);

	const searchPlaylistDetailArtist = useCallback((artist: string) => {
		const keyword = artist.trim();
		if (!keyword) return;
		setPlaylistDetail(null);
		dependenciesRef.current.searchQuery(keyword, "song");
	}, []);

	const playPrivate = useCallback(async () => {
		const current = dependenciesRef.current;
		const nextDiscover = discover?.loggedIn ? discover : await refreshDiscover();
		if (!hasLogin() && !nextDiscover?.loggedIn) {
			current.openLogin();
			current.showToast("登录后同步更多歌曲");
			return;
		}
		if (nextDiscover?.dailySongs.length) {
			await playDiscoverSongs(0);
			return;
		}
		if (nextDiscover?.playlists.length) {
			await openPlaylist(0);
			return;
		}
		current.openLibrarySurface();
	}, [discover, hasLogin, openPlaylist, playDiscoverSongs, refreshDiscover]);

	const playPodcastRadio = useCallback(async (id: string, title = "播客") => {
		const current = dependenciesRef.current;
		if (!id || !current.search) {
			current.searchQuery(title || "播客", "podcast");
			return;
		}
		try {
			const detail = await current.search.podcastPrograms(id, 30, 0);
			if (!detail.programs.length) {
				current.searchQuery(title || "播客", "podcast");
				return;
			}
			current.playback.setQueue(detail.programs);
			current.playback.playAt(0);
			enterPlayback();
			current.showToast(title || "播客");
		} catch (error) {
			current.showToast(error instanceof Error ? error.message : "播客载入失败");
		}
	}, [enterPlayback]);

	const openPodcast = useCallback(
		async (index: number) => {
			const nextDiscover = discover?.loggedIn ? discover : await refreshDiscover();
			const item = nextDiscover?.podcasts[index];
			if (!item) {
				dependenciesRef.current.searchQuery("", "podcast");
				return;
			}
			await playPodcastRadio(item.id, item.name || "播客");
		},
		[discover, playPodcastRadio, refreshDiscover],
	);

	const playWeatherSong = useCallback(
		async (index: number) => {
			const current = dependenciesRef.current;
			let radio = weatherRadio;
			if (!radio?.radio.songs.length) {
				current.showToast("正在生成天气电台");
				radio = await refreshWeatherRadio();
			}
			const songs = radio?.radio.songs ?? [];
			if (!songs.length) {
				const seed = radio?.radio.seedQueries[0] || "雨天 R&B";
				current.showToast("天气队列暂时为空，先打开搜索");
				current.searchQuery(seed, "song");
				return;
			}
			const targetIndex = Math.max(0, Math.min(index, songs.length - 1));
			current.playback.setQueue(songs);
			current.playback.playAt(targetIndex);
			enterPlayback();
			current.showToast(`${radio?.radio.title || "天气电台"} · ${songs.length} 首`);
		},
		[enterPlayback, refreshWeatherRadio, weatherRadio],
	);

	const openPodcastSearch = useCallback(() => {
		dependenciesRef.current.searchQuery("", "podcast");
	}, []);

	const openInsight = useCallback(() => {
		const current = dependenciesRef.current;
		const artist = listenSummary?.topArtist?.name;
		if (artist) {
			current.searchQuery(artist);
			return;
		}
		const song = listenSummary?.topSong?.track.title;
		if (song) {
			current.searchQuery(song);
			return;
		}
		current.showToast("播放几首歌后会生成听歌画像");
	}, [listenSummary]);

	const playRecent = useCallback(() => {
		const current = dependenciesRef.current;
		const track = listenSummary?.recent?.track;
		if (track) {
			current.playback.setQueue([track]);
			current.playback.playAt(0);
			enterPlayback();
			return;
		}
		current.showToast("还没有听歌记录");
	}, [enterPlayback, listenSummary]);

	return {
		discover,
		recommendations,
		weatherRadio,
		playlistDetail,
		recommendationDetail,
		discoverLoading,
		recommendationsLoading,
		weatherRadioLoading,
		discoverError,
		recommendationsError,
		weatherRadioError,
		forcedOpen,
		suppressed,
		listenSummary,
		dashboard,
		setForcedOpen,
		setSuppressed,
		refreshDiscover,
		refreshRecommendations,
		refreshWeatherRadio,
		recordListenPause,
		recordListenProgress,
		finalizeListenSession,
		playDaily,
		playPrivate,
		playDiscoverSongs,
		openPlaylist,
		closePlaylistDetail,
		playPlaylistDetail,
		openRecommendations,
		closeRecommendations,
		playRecommendationTrack,
		playRecommendationStream,
		openRecommendationPlaylist,
		loadMorePlaylistTracks,
		searchPlaylistDetailArtist,
		openPodcast,
		openPodcastSearch,
		playWeatherSong,
		openInsight,
		playRecent,
		continueListening,
		playNextUp,
		playForYou,
		enterPlaybackSurface: enterPlayback,
	};
}
