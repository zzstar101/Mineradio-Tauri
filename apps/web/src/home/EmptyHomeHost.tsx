import { useState, type CSSProperties, type KeyboardEvent, type ReactElement } from "react";
import type {
	DiscoverHomeResponse,
	PlaylistSummary,
	PodcastRadio,
	ProviderId,
	RecommendationCard as RecommendationCardData,
	RecommendationPage,
	Track,
	WeatherRadioResponse,
} from "@mineradio/shared";
import { resolveVirtualListWindow } from "../components/shell/virtual-list";
import { HomeDashboardHero } from "../features/home/HomeDashboardHero";
import { buildHomeRecommendationPreviews } from "../features/home/home-recommendation-preview-policy";
import { HOME_PROVIDER_LABELS } from "../features/home/home-provider-labels";
import { RecommendationCard as RecommendationCardView } from "../features/recommendation/RecommendationCard";
import { RecommendationPage as RecommendationPageScreen } from "../features/recommendation/RecommendationPage";
import {
	chunkIntoColumns,
	type RecommendationDetail,
} from "../features/recommendation/recommendation-page-policy";
import {
	buildHomeDashboardModel,
	type HomeDashboardModel,
} from "../features/home/home-dashboard-policy";
import type { HomeHeroVideoRepository } from "../features/home/home-hero-video";
import type {
	HomeListenRecord,
	HomeListenSummary,
} from "../features/home/home-listen-ledger";

export type {
	HomeListenRecord,
	HomeListenSummary,
} from "../features/home/home-listen-ledger";

export interface EmptyHomeHostProps {
	discover?: DiscoverHomeResponse | null;
	recommendations?: RecommendationPage[] | null;
	weatherRadio?: WeatherRadioResponse | null;
	listenSummary?: HomeListenSummary | null;
	dashboard?: HomeDashboardModel | null;
	playlistDetail?: HomePlaylistDetailView | null;
	recommendationDetail?: RecommendationDetail | null;
	active?: boolean;
	loading?: boolean;
	discoverError?: string | null;
	recommendationsError?: string | null;
	weatherRadioError?: string | null;
	isPlaying?: boolean;
	positionMs?: number;
	durationMs?: number | null;
	onSearchFocus?: () => void;
	onOpenLibrary?: () => void;
	onOpenConsole?: () => void;
	onSearchQuery?: (query: string) => void;
	onUpload?: () => void;
	onGuide?: () => void;
	onOpenLogin?: () => void;
	onPlayDaily?: () => void;
	onPlayPrivate?: () => void;
	onPlaySong?: (index: number) => void;
	onOpenPlaylist?: (index: number) => void;
	onOpenPodcast?: (index: number) => void;
	onOpenPodcastSearch?: () => void;
	onOpenInsight?: () => void;
	onPlayRecent?: () => void;
	onContinue?: () => void;
	onPlayNextUp?: () => void;
	onPlayForYou?: (index: number) => void;
	onPlayWeatherSong?: (index: number) => void;
	onRetryDiscover?: () => void;
	onRetryRecommendations?: () => void;
	onRetryWeatherRadio?: () => void;
	onClosePlaylistDetail?: () => void;
	onPlayPlaylistDetail?: (index: number) => void;
	onOpenRecommendations?: (provider: ProviderId) => void;
	onCloseRecommendations?: () => void;
	onPlayRecommendationTrack?: (provider: ProviderId, card: RecommendationCardData) => void;
	onOpenRecommendationPlaylist?: (provider: ProviderId, card: RecommendationCardData) => void;
	onPlaylistDetailArtist?: (artist: string, track: Track) => void;
	onNotice?: (message: string) => void;
	heroVideoRepository?: HomeHeroVideoRepository;
}

export interface HomePlaylistDetailView {
	key?: string;
	playlist: PlaylistSummary;
	tracks: Track[];
	loading?: boolean;
	error?: string;
}

interface HomeWaveBar {
	height: number;
	opacity: number;
}

interface HomeWaveFrame {
	bars: HomeWaveBar[];
	smooth: number[];
}

const HOME_WAVE_BAR_COUNT = 24;
const HOME_RAIL_MAX_TILES = 32;
const HOME_RAIL_PRIMARY_SONG_COUNT = 4;
const HOME_PROVIDER_ORDER: ProviderId[] = ["netease", "qq", "soda"];

const STARTER_TILES = [
	{ kind: "login", tone: "library", title: "登录同步歌单", sub: "网易云 / QQ 音乐", action: "Login" },
	{ kind: "search", tone: "search", title: "搜索一首歌", sub: "原唱优先", action: "Search", query: "" },
	{ kind: "local", tone: "local", title: "导入本地音乐", sub: "本地文件也能可视化", action: "Import" },
	{ kind: "podcastSearch", tone: "podcast", title: "搜索播客", sub: "长内容 / 电台", action: "Podcast" },
	{ kind: "guide", tone: "guide", title: "看看视觉舞台", sub: "粒子 / 歌词 / 封面", action: "Visual" },
] as const;

type StarterTile = (typeof STARTER_TILES)[number];

type HomeTile =
	| StarterTile
	| { kind: "recent"; tone: string; title: string; sub: string; action: string; record: HomeListenRecord; coverUrl?: string }
	| { kind: "profile"; tone: string; title: string; sub: string; action: string; query: string; coverUrl?: string }
	| { kind: "forYou"; tone: string; title: string; sub: string; action: string; index: number; coverUrl?: string }
	| { kind: "song"; tone: string; title: string; sub: string; action: string; index: number; coverUrl?: string }
	| { kind: "playlist"; tone: string; title: string; sub: string; action: string; index: number; provider: ProviderId; coverUrl?: string }
	| { kind: "podcast"; tone: string; title: string; sub: string; action: string; index: number; coverUrl?: string }
	| { kind: "weatherSong"; tone: string; title: string; sub: string; action: string; index: number; coverUrl?: string };

interface HomeRailSection {
	id: string;
	title: string;
	note: string;
	tiles: HomeTile[];
	provider?: ProviderId;
}

function artistLine(track: Track | null | undefined, fallback = "推荐歌曲"): string {
	if (!track) return fallback;
	return track.artists.length ? track.artists.join(" / ") : fallback;
}

function coverStyle(url: string | undefined): CSSProperties | undefined {
	return url ? { backgroundImage: `url("${url}")` } : undefined;
}

function clampHomeWave(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function buildHomeWaveFrame(input: {
	timeMs: number;
	isPlaying?: boolean;
	positionMs?: number;
	durationMs?: number | null;
}, previous: number[] = []): HomeWaveFrame {
	const smooth = Array.from({ length: HOME_WAVE_BAR_COUNT }, (_, index) => previous[index] || 0);
	const nowT = Math.max(0, input.timeMs) / 1000;
	const positionSeconds = Math.max(0, Number(input.positionMs || 0)) / 1000;
	const progress = input.durationMs && input.durationMs > 0
		? clampHomeWave(Number(input.positionMs || 0) / input.durationMs, 0, 1)
		: 0;
	const playingPulse = input.isPlaying
		? 0.16 + Math.abs(Math.sin(positionSeconds * 2.15 + progress * Math.PI)) * 0.26
		: 0;
	const bars = smooth.map((previousValue, index) => {
		const ratio = HOME_WAVE_BAR_COUNT > 1 ? index / (HOME_WAVE_BAR_COUNT - 1) : 0;
		const fallbackBin = 0.16 + Math.sin(nowT * 1.4 + index * 0.34) * 0.06;
		const beatPulse = input.isPlaying ? Math.abs(Math.sin(positionSeconds * 4.2 + index * 0.08)) * 0.24 : 0;
		const target = clampHomeWave(Math.max(
			fallbackBin,
			playingPulse * 0.35 + fallbackBin * 0.18 + beatPulse * 0.24 + ratio * 0.018,
		), 0.03, 1);
		const next = previousValue + (target - previousValue) * (target > previousValue ? 0.34 : 0.12);
		smooth[index] = next;
		return {
			height: Math.max(4, next * 18),
			opacity: clampHomeWave(0.36 + next * 0.68, 0.32, 1),
		};
	});
	return { bars, smooth };
}

function cardCoverClass(url: string | undefined): string {
	return url ? "home-card-art has-cover" : "home-card-art";
}

function playlistSub(playlist: PlaylistSummary | null | undefined): string {
	if (!playlist) return "打开左侧歌单库";
	return `${playlist.trackCount ? `${playlist.trackCount} 首 · ` : ""}打开左侧歌单库`;
}

function podcastSub(podcast: PodcastRadio | null | undefined): string {
	if (!podcast) return "长内容 / 电台";
	return podcast.djName || podcast.category || "Podcast";
}

function pushTile(tiles: HomeTile[], tile: HomeTile, max = HOME_RAIL_MAX_TILES): void {
	if (tiles.length < max) tiles.push(tile);
}

function buildHomeTiles(
	discover: DiscoverHomeResponse | null | undefined,
	weatherRadio: WeatherRadioResponse | null | undefined,
	listenSummary: HomeListenSummary | null | undefined,
	dashboard: HomeDashboardModel,
): HomeTile[] {
	const weatherSongs = weatherRadio?.radio.songs ?? [];
	const playlists = discover?.playlists ?? [];
	const podcasts = discover?.podcasts ?? [];
	const tiles: HomeTile[] = [];

	dashboard.forYou.forEach((track, index) => {
		pushTile(tiles, {
			kind: "forYou",
			tone: index % 2 ? "search" : "daily",
			title: track.title || "为你推荐",
			sub: artistLine(track, "为你推荐"),
			action: "Play",
			index,
			coverUrl: track.coverUrl,
		});
	});

	if (listenSummary?.recent?.track) {
		const recent = listenSummary.recent;
		pushTile(tiles, {
			kind: "recent",
			tone: "search",
			title: recent.track.title || "继续听",
			sub: artistLine(recent.track, "最近播放"),
			action: "Play",
			record: recent,
			coverUrl: recent.track.coverUrl,
		});
	}

	if (listenSummary?.topArtist?.name) {
		pushTile(tiles, {
			kind: "profile",
			tone: "local",
			title: listenSummary.topArtist.name,
			sub: `常听歌手 · ${listenSummary.topArtist.plays} 次`,
			action: "Search",
			query: listenSummary.topArtist.name,
			coverUrl: listenSummary.topArtist.coverUrl,
		});
	}

	if (!discover?.loggedIn) {
		playlists.forEach((playlist, index) => pushTile(tiles, {
			kind: "playlist",
			tone: "playlist",
			title: playlist.name || "推荐歌单",
			sub: playlist.trackCount ? `${playlist.trackCount} 首 · 公开推荐` : "公开推荐",
			action: "Open",
			index,
			provider: playlist.provider,
			coverUrl: playlist.coverUrl,
		}));
		weatherSongs.forEach((song, index) => pushTile(tiles, {
			kind: "weatherSong",
			tone: "daily",
			title: song.title || "天气电台歌曲",
			sub: artistLine(song, "天气电台"),
			action: "Play",
			index,
			coverUrl: song.coverUrl,
		}));
		if (playlists.length || !weatherSongs.length) {
			STARTER_TILES.forEach((tile) => pushTile(tiles, tile));
		}
		return tiles.length ? tiles.slice(0, HOME_RAIL_MAX_TILES) : [...STARTER_TILES];
	}

	discover.dailySongs.slice(0, HOME_RAIL_PRIMARY_SONG_COUNT).forEach((song, index) => {
		pushTile(tiles, {
			kind: "song",
			tone: index % 2 ? "search" : "daily",
			title: song.title || "今日歌曲",
			sub: artistLine(song, "今日歌曲"),
			action: "Play",
			index,
			coverUrl: song.coverUrl,
		});
	});

	playlists.forEach((playlist, index) => {
		pushTile(tiles, {
			kind: "playlist",
			tone: "playlist",
			title: playlist.name || "推荐歌单",
			sub: playlist.trackCount ? `${playlist.trackCount} 首` : "Playlist",
			action: "Open",
			index,
			provider: playlist.provider,
			coverUrl: playlist.coverUrl,
		});
	});

	podcasts.forEach((podcast, index) => {
		pushTile(tiles, {
			kind: "podcast",
			tone: "podcast",
			title: podcast.name || "热门播客",
			sub: podcastSub(podcast),
			action: "Podcast",
			index,
			coverUrl: podcast.coverUrl,
		});
	});

	weatherSongs.forEach((song, index) => {
		pushTile(tiles, {
			kind: "weatherSong",
			tone: "daily",
			title: song.title || "天气电台歌曲",
			sub: artistLine(song, "天气电台"),
			action: "Play",
			index,
			coverUrl: song.coverUrl,
		});
	});

	return tiles.length ? tiles.slice(0, HOME_RAIL_MAX_TILES) : [...STARTER_TILES];
}

function isStarterTile(tile: HomeTile): tile is StarterTile {
	return tile.kind === "login" ||
		tile.kind === "search" ||
		tile.kind === "local" ||
		tile.kind === "podcastSearch" ||
		tile.kind === "guide";
}

function providerPlaylistSectionTitle(provider: ProviderId, loggedOut: boolean): string {
	if (loggedOut && provider === "netease") return "网易云推荐歌单";
	return `${HOME_PROVIDER_LABELS[provider]}歌单`;
}

function providerPlaylistSectionNote(provider: ProviderId, count: number, loggedOut: boolean): string {
	const source = loggedOut && provider === "netease" ? "公开推荐" : "用户歌单";
	return `${count} 个 · ${source}`;
}

function buildHomeRailSections(tiles: HomeTile[], loggedOut: boolean): HomeRailSection[] {
	const sections: HomeRailSection[] = [];
	const personalTiles = tiles.filter((tile) => tile.kind === "recent" || tile.kind === "profile");
	const forYouTiles = tiles.filter((tile) => tile.kind === "forYou");
	const songTiles = tiles.filter((tile) => tile.kind === "song");
	const playlistTiles = tiles.filter((tile): tile is Extract<HomeTile, { kind: "playlist" }> => tile.kind === "playlist");
	const podcastTiles = tiles.filter((tile) => tile.kind === "podcast");
	const weatherTiles = tiles.filter((tile) => tile.kind === "weatherSong");
	const starterTiles = tiles.filter(isStarterTile);

	if (personalTiles.length) {
		sections.push({
			id: "personal",
			title: "继续收听",
			note: `${personalTiles.length} 个 · 最近偏好`,
			tiles: personalTiles,
		});
	}

	if (forYouTiles.length) {
		sections.push({
			id: "for-you",
			title: "For You",
			note: `${forYouTiles.length} 首 · 今日稳定推荐`,
			tiles: forYouTiles,
		});
	}

	if (songTiles.length) {
		sections.push({
			id: "daily",
			title: loggedOut ? "推荐歌曲" : "今日推荐歌曲",
			note: `${songTiles.length} 首 · 个性化推荐`,
			tiles: songTiles,
		});
	}

	HOME_PROVIDER_ORDER.forEach((provider) => {
		const providerTiles = playlistTiles.filter((tile) => tile.provider === provider);
		if (!providerTiles.length) return;
		sections.push({
			id: `provider-${provider}`,
			title: providerPlaylistSectionTitle(provider, loggedOut),
			note: providerPlaylistSectionNote(provider, providerTiles.length, loggedOut),
			tiles: providerTiles,
			provider,
		});
	});

	if (podcastTiles.length) {
		sections.push({
			id: "podcasts",
			title: "播客与电台",
			note: `${podcastTiles.length} 个 · 热门内容`,
			tiles: podcastTiles,
		});
	}

	if (weatherTiles.length) {
		sections.push({
			id: "weather",
			title: "天气电台",
			note: `${weatherTiles.length} 首 · 当前氛围`,
			tiles: weatherTiles,
		});
	}

	if (starterTiles.length) {
		sections.push({
			id: "starter",
			title: "开始探索",
			note: loggedOut ? "登录后同步多平台歌单" : "更多入口",
			tiles: starterTiles,
		});
	}

	return sections.length ? sections : [{
		id: "starter",
		title: "开始探索",
		note: "选择一个入口",
		tiles: [...STARTER_TILES],
	}];
}

function homeTileCover(tile: HomeTile): string | undefined {
	return "coverUrl" in tile ? tile.coverUrl : undefined;
}

function homeTileKey(tile: HomeTile, index: number): string {
	if (tile.kind === "song" || tile.kind === "forYou" || tile.kind === "playlist" || tile.kind === "podcast" || tile.kind === "weatherSong") {
		return `${tile.kind}:${tile.index}:${tile.title}`;
	}
	if (tile.kind === "recent") return `${tile.kind}:${tile.record.track.provider}:${tile.record.track.id}`;
	if (tile.kind === "profile") return `${tile.kind}:${tile.query}`;
	return `${tile.kind}:${index}:${tile.title}`;
}

function handleTileAction(props: EmptyHomeHostProps, tile: HomeTile): void {
	if (tile.kind === "login") props.onOpenLogin?.();
	else if (tile.kind === "search") props.onSearchQuery?.(tile.query ?? "") ?? props.onSearchFocus?.();
	else if (tile.kind === "local") props.onUpload?.();
	else if (tile.kind === "podcastSearch") props.onOpenPodcastSearch?.();
	else if (tile.kind === "guide") props.onGuide?.();
	else if (tile.kind === "recent") props.onPlayRecent?.();
	else if (tile.kind === "profile") props.onOpenInsight?.();
	else if (tile.kind === "forYou") props.onPlayForYou?.(tile.index);
	else if (tile.kind === "song") props.onPlaySong?.(tile.index);
	else if (tile.kind === "playlist") props.onOpenPlaylist?.(tile.index);
	else if (tile.kind === "podcast") props.onOpenPodcast?.(tile.index);
	else if (tile.kind === "weatherSong") props.onPlayWeatherSong?.(tile.index);
}

function homeDetailTrackKey(track: Track, index: number): string {
	return `${track.provider}:${track.id}:${index}`;
}

function handleDetailTrackKeyDown(event: KeyboardEvent<HTMLDivElement>, action: () => void): void {
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	action();
}

function formatDurationMs(durationMs: number | undefined): string {
	if (!durationMs) return "";
	const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const HOME_DETAIL_ROW_HEIGHT = 66;
const HOME_DETAIL_VIEWPORT_HEIGHT = 528;

function HomePlaylistDetailPage({
	props,
	detail,
}: {
	props: EmptyHomeHostProps;
	detail: HomePlaylistDetailView;
}): ReactElement {
	const playlist = detail.playlist;
	const tracks = detail.tracks;
	const [scrollTop, setScrollTop] = useState(0);
	const virtualWindow = resolveVirtualListWindow({
		itemCount: tracks.length,
		rowHeight: HOME_DETAIL_ROW_HEIGHT,
		viewportHeight: HOME_DETAIL_VIEWPORT_HEIGHT,
		scrollTop,
		threshold: 80,
	});
	const visibleTracks = tracks.slice(
		virtualWindow.startIndex,
		virtualWindow.endIndex,
	);
	const virtualStyle: CSSProperties | undefined = virtualWindow.virtualized
		? {
				maxHeight: HOME_DETAIL_VIEWPORT_HEIGHT,
				overflowY: "auto",
				paddingTop: virtualWindow.paddingTop,
				paddingBottom: virtualWindow.paddingBottom,
			}
		: undefined;
	const provider = playlist.provider;
	const providerName = HOME_PROVIDER_LABELS[provider];
	const totalCount = playlist.trackCount ?? tracks.length;
	const cover = playlist.coverUrl || tracks.find((track) => track.coverUrl)?.coverUrl;
	const loadedCount = tracks.length;
	const loadedLabel = totalCount && totalCount !== loadedCount
		? `${loadedCount}/${totalCount}`
		: `${loadedCount || totalCount || 0}`;

	return (
		<section id="empty-home" className="home-detail-active" aria-label="Playlist detail">
			<div className="home-playlist-detail" data-home-playlist-detail data-home-provider={provider}>
				<div className="home-detail-toolbar">
					<button className="home-detail-back" type="button" onClick={props.onClosePlaylistDetail}>返回首页</button>
					<div className="home-detail-provider">{providerName}</div>
				</div>
				<div className="home-detail-hero">
					<div className={`home-detail-cover${cover ? " has-cover" : ""}`} style={coverStyle(cover)} />
					<div className="home-detail-copy">
						<div className="home-detail-kicker">歌单</div>
						<h2 className="home-detail-title">{playlist.name || "歌单详情"}</h2>
						<div className="home-detail-meta">
							<span>{providerName}</span>
							<span>{detail.loading ? "载入中" : `已载入 ${loadedLabel} 首`}</span>
							<span>{playlist.subscribed ? "收藏歌单" : "首页歌单"}</span>
						</div>
						{detail.error ? <div className="home-detail-error">{detail.error}</div> : null}
						<button className="home-detail-play" type="button" disabled={detail.loading || tracks.length === 0} onClick={() => props.onPlayPlaylistDetail?.(0)}>
							播放全部
						</button>
					</div>
				</div>
				<div className="home-detail-tabs" aria-label="Playlist sections">
					<div className="active">歌曲 <strong>{loadedCount || totalCount || 0}</strong></div>
				</div>
				<div className="home-detail-list-head">
					<div>#</div>
					<div>标题</div>
					<div>专辑</div>
					<div>时长</div>
				</div>
				<div
					className="home-detail-list"
					aria-label="Playlist tracks"
					data-virtualized={virtualWindow.virtualized ? "true" : undefined}
					onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
					style={virtualStyle}
				>
					{detail.loading ? (
						<div className="home-detail-empty">正在载入歌单</div>
					) : tracks.length === 0 ? (
						<div className="home-detail-empty">{detail.error || "歌单暂无可播放歌曲"}</div>
					) : visibleTracks.map((track, localIndex) => {
						const index = virtualWindow.startIndex + localIndex;
						const artist = artistLine(track, "未知歌手");
						return (
							<div
								className="home-detail-track"
								data-home-detail-track={index}
								key={homeDetailTrackKey(track, index)}
								onClick={() => props.onPlayPlaylistDetail?.(index)}
								onKeyDown={(event) => handleDetailTrackKeyDown(event, () => props.onPlayPlaylistDetail?.(index))}
								role="button"
								tabIndex={0}
							>
								<div className="home-detail-track-index">{String(index + 1).padStart(2, "0")}</div>
								<div className="home-detail-track-main">
									<div className={`home-detail-track-cover${track.coverUrl ? " has-cover" : ""}`} style={coverStyle(track.coverUrl)} />
									<div className="home-detail-track-text">
										<div className="home-detail-track-title">{track.title || "未命名歌曲"}</div>
										<div className="home-detail-track-sub">
											<button className="home-detail-artist" type="button" onClick={(event) => {
												event.stopPropagation();
												props.onPlaylistDetailArtist?.(artist, track);
											}}>{artist}</button>
										</div>
									</div>
								</div>
								<div className="home-detail-track-album">{track.album || "-"}</div>
								<div className="home-detail-track-side">
									<span>{formatDurationMs(track.durationMs)}</span>
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</section>
	);
}

export function EmptyHomeHost(props: EmptyHomeHostProps): ReactElement {
	// 歌单详情优先于推荐页：在推荐页里点歌单卡片时，
	// recommendationDetail 仍然非空，若它先行判断会永远挡住详情页。
	if (props.playlistDetail) {
		return <HomePlaylistDetailPage props={props} detail={props.playlistDetail} />;
	}
	if (props.recommendationDetail) {
		return <RecommendationPageScreen props={props} detail={props.recommendationDetail} />;
	}

	const discover = props.discover ?? null;
	const loggedOut = !discover?.loggedIn;
	const hasWeatherSongs = !!props.weatherRadio?.radio.songs.length;
	const daily = discover?.dailySongs[0] ?? null;
	const privateSong = discover?.dailySongs[1] ?? null;
	const thirdSong = discover?.dailySongs[2] ?? null;
	const firstPlaylist = discover?.playlists[0] ?? null;
	const firstPodcast = discover?.podcasts[0] ?? null;
	const listenSummary = props.listenSummary ?? null;
	const dashboard = props.dashboard ?? buildHomeDashboardModel({
		discover,
		listenSummary,
		queue: [],
		currentTrack: null,
		isPlaying: props.isPlaying,
	});
	const tiles = buildHomeTiles(
		discover,
		props.weatherRadio,
		listenSummary,
		dashboard,
	);
	const railSections = buildHomeRailSections(tiles, loggedOut);
	const recommendationPreviews = buildHomeRecommendationPreviews(props.recommendations ?? []);
	const loading = props.loading === true;
	const hasPublicRecommendations = loggedOut && (discover?.playlists.length ?? 0) > 0;
	const libraryCover = firstPlaylist?.coverUrl || daily?.coverUrl;
	const dailyCover = daily?.coverUrl;
	const privateCover = privateSong?.coverUrl || daily?.coverUrl || firstPlaylist?.coverUrl;
	const recentTrack = listenSummary?.recent?.track ?? null;
	const topSong = listenSummary?.topSong?.track ?? null;
	const topArtist = listenSummary?.topArtist ?? null;
	const continueCover = recentTrack?.coverUrl || firstPlaylist?.coverUrl;
	const profileCover = topSong?.coverUrl || topArtist?.coverUrl || firstPodcast?.coverUrl;
	const moreCover = thirdSong?.coverUrl || topSong?.coverUrl || recentTrack?.coverUrl || firstPodcast?.coverUrl;
	const nextUp = dashboard.nextUp;
	const firstForYou = dashboard.forYou[0] ?? null;
	const continueTrack = dashboard.continue.track;
	const playContinue = () => {
		if (props.onContinue) props.onContinue();
		else if (dashboard.continue.kind === "daily") props.onPlayDaily?.();
		else props.onPlayRecent?.();
	};
	const recommendationPreviewNodes = recommendationPreviews.length ? (
		<div className="home-recommendation-previews" aria-label="Provider recommendations">
			{recommendationPreviews.map((preview) => (
				<section
					className="home-rail-section"
					data-home-provider={preview.provider}
					data-home-recommendation-preview={preview.provider}
					key={`recommendation-${preview.provider}`}
				>
					<div className="home-rail-section-head">
						<button
							className="home-rail-section-title home-recommendation-module-title"
							type="button"
							onClick={() => props.onOpenRecommendations?.(preview.provider)}
						>
							{HOME_PROVIDER_LABELS[preview.provider]}
							{preview.title.trim() ? ` · ${preview.title}` : null}
						</button>
					</div>
					{preview.kind === "Track" ? (
						<div className="home-recommendation-track-row">
							{chunkIntoColumns(preview.cards, 3).map((column, columnIndex) => (
								<div
									className="home-recommendation-track-column"
									key={`${preview.provider}-column-${columnIndex}`}
								>
									{column.map((card, index) => (
										<RecommendationCardView
											key={`${preview.provider}-${card.id}-${index}`}
											provider={preview.provider}
											moduleKind={preview.kind}
											card={card}
											index={index}
											onPlayTrack={props.onPlayRecommendationTrack}
											onOpenPlaylist={props.onOpenRecommendationPlaylist}
										/>
									))}
								</div>
							))}
						</div>
					) : (
						<div
							className={
								preview.kind === "Mixed" && preview.provider === "netease"
									? "home-recommendation-netease-mixed-row"
									: "home-recommendation-tile-row"
							}
						>
							{preview.cards.map((card, index) => (
								<RecommendationCardView
									key={`${preview.provider}-${card.id}-${index}`}
									provider={preview.provider}
									moduleKind={preview.kind}
									card={card}
									index={index}
									onPlayTrack={props.onPlayRecommendationTrack}
									onOpenPlaylist={props.onOpenRecommendationPlaylist}
								/>
							))}
						</div>
					)}
				</section>
			))}
		</div>
	) : null;

	return (
		<section id="empty-home" aria-label="Mineradio home">
			<div className="empty-home-shell">
				<div className="home-hero">
					<HomeDashboardHero
						active={props.active === true}
						onNotice={props.onNotice}
						onOpenConsole={props.onOpenConsole}
						repository={props.heroVideoRepository}
					/>
				</div>

				<div className="home-right-pane">
					{props.discoverError || props.recommendationsError || props.weatherRadioError ? (
						<div className="home-local-errors" aria-label="首页载入状态">
							{props.discoverError ? (
								<div className="home-local-error" role="status" data-home-error="discover">
									<span>推荐内容载入失败：{props.discoverError}</span>
									<button type="button" onClick={props.onRetryDiscover}>重试推荐</button>
								</div>
							) : null}
							{props.recommendationsError ? (
								<div className="home-local-error" role="status" data-home-error="recommendations">
									<span>推荐预览载入失败：{props.recommendationsError}</span>
									<button type="button" onClick={props.onRetryRecommendations}>重试推荐</button>
								</div>
							) : null}
							{props.weatherRadioError ? (
								<div className="home-local-error" role="status" data-home-error="weather">
									<span>天气电台载入失败：{props.weatherRadioError}</span>
									<button type="button" onClick={props.onRetryWeatherRadio}>重试天气</button>
								</div>
							) : null}
						</div>
					) : null}
					{recommendationPreviewNodes}
					<div className="home-insight-dock" aria-label="今日收听概览">
						<div className="home-insight-item"><span>今日</span><strong>{Math.round(dashboard.insight.todayListenMs / 60_000)} 分钟</strong></div>
						<div className="home-insight-item"><span>歌曲</span><strong>{dashboard.insight.todayUniqueSongs} 首</strong></div>
						<button className="home-insight-item" type="button" onClick={props.onOpenInsight}><span>常听</span><strong>{dashboard.insight.topArtist?.name || "等待记录"}</strong></button>
						<div className="home-insight-item"><span>连续</span><strong>{dashboard.insight.streakDays} 天</strong></div>
					</div>
					<div className="home-grid">
						<button className="home-card" data-home-card="library" data-home-tone="library" type="button" onClick={props.onOpenLibrary}>
							<div className="home-card-label">Library</div>
							<div className="home-card-title" id="home-weather-card-title">{loggedOut ? "本地音乐" : "我的歌单"}</div>
							<div className="home-card-sub" id="home-weather-card-sub">{loggedOut ? "导入本地音乐" : playlistSub(firstPlaylist)}</div>
							<div className={cardCoverClass(libraryCover)} id="home-weather-art" style={coverStyle(libraryCover)} />
						</button>
						<button className="home-card" data-home-card="daily" data-home-tone="mix" type="button" onClick={props.onPlayDaily}>
							<div className="home-card-label">Daily</div>
							<div className="home-card-title" id="home-daily-title">{loggedOut ? "每日推荐" : (daily?.title || "每日推荐")}</div>
							<div className="home-card-sub" id="home-daily-sub">{loggedOut ? "登录后同步你的今日歌曲" : (daily ? `当前已载入 ${dashboard.dailyLoadedCount} 首 · ${artistLine(daily, "今日歌曲")}` : "同步你的今日歌曲")}</div>
							<div className={cardCoverClass(dailyCover)} id="home-daily-art" style={coverStyle(dailyCover)} />
						</button>
						<button
							className="home-card"
							data-home-card="private"
							data-home-tone="playlist"
							type="button"
							onClick={() => {
								if (recentTrack && props.onPlayRecent) props.onPlayRecent();
								else props.onPlayPrivate?.();
							}}
						>
							<div className="home-card-label">Recent</div>
							<div className="home-card-title" id="home-private-title">{recentTrack?.title || "最近播放"}</div>
							<div className="home-card-sub" id="home-private-sub">{recentTrack ? artistLine(recentTrack) : "有效播放后会出现在这里"}</div>
							<div className={cardCoverClass(privateCover)} id="home-private-art" style={coverStyle(privateCover)} />
						</button>
						<button className="home-card" data-home-card="continue" data-home-tone="mix" type="button" onClick={playContinue}>
							<div className="home-card-label">Continue</div>
							<div className="home-card-title" id="home-continue-title">{dashboard.continue.title}</div>
							<div className="home-card-sub" id="home-continue-sub">{dashboard.continue.subtitle}</div>
							<div className={cardCoverClass(continueTrack?.coverUrl || continueCover)} id="home-continue-art" style={coverStyle(continueTrack?.coverUrl || continueCover)} />
						</button>
						<button className="home-card" data-home-card="profile" data-home-tone="local" type="button" onClick={props.onPlayNextUp ?? props.onOpenInsight}>
							<div className="home-card-label">Next Up</div>
							<div className="home-card-title" id="home-profile-title">{nextUp?.title || topArtist?.name || topSong?.title || "队列末尾"}</div>
							<div className="home-card-sub" id="home-profile-sub">{nextUp ? artistLine(nextUp) : (topArtist ? `常听歌手 · ${topArtist.plays} 次` : "当前队列没有下一首")}</div>
							<div className={cardCoverClass(nextUp?.coverUrl || profileCover)} id="home-profile-art" style={coverStyle(nextUp?.coverUrl || profileCover)} />
						</button>
						<button className="home-card" data-home-card="more" data-home-tone="local" type="button" onClick={() => {
							if (props.onPlayForYou) props.onPlayForYou(0);
							else props.onPlaySong?.(2);
						}}>
							<div className="home-card-label">For You</div>
							<div className="home-card-title" id="home-library-title">{firstForYou?.title || "为你推荐"}</div>
							<div className="home-card-sub" id="home-library-sub">{firstForYou ? `${artistLine(firstForYou)} · 今日稳定` : "播放几首后生成推荐"}</div>
							<div className={cardCoverClass(firstForYou?.coverUrl || moreCover)} id="home-library-art" style={coverStyle(firstForYou?.coverUrl || moreCover)} />
						</button>
					</div>

					<div className="home-rail">
						<div className="home-section-head">
							<div className="home-section-title" id="home-rail-title">{loggedOut ? (hasPublicRecommendations ? "推荐歌单与开始探索" : "先从这里开始") : "你的歌单与推荐"}</div>
							<div className="home-section-note" id="home-rail-note">{loggedOut && !hasWeatherSongs && !hasPublicRecommendations ? "正在等待推荐源" : "按供应商分组 · 点击即可播放"}</div>
						</div>
						<div id="home-tile-row" className="home-rail-sections">
							{railSections.map((section) => (
								<section
									className="home-rail-section"
									data-home-rail-section={section.id}
									data-home-provider={section.provider}
									key={section.id}
								>
									<div className="home-rail-section-head">
										<div className="home-rail-section-title">{section.title}</div>
										<div className="home-rail-section-note">{section.note}</div>
									</div>
									<div className="home-tile-row">
										{section.tiles.map((tile, index) => (
											<button
												className={`home-tile${!homeTileCover(tile) && loading ? " home-skeleton" : ""}`}
												data-home-tone={tile.tone}
												type="button"
												aria-label={`${tile.title} ${tile.action}`}
												title={tile.action}
												onClick={() => handleTileAction(props, tile)}
												key={homeTileKey(tile, index)}
											>
												<div className={`home-tile-cover${"coverUrl" in tile && tile.coverUrl ? " has-cover" : ""}`} style={"coverUrl" in tile ? coverStyle(tile.coverUrl) : undefined} />
												<div className="home-tile-title">{tile.title}</div>
												<div className="home-tile-sub">{tile.sub}</div>
											</button>
										))}
									</div>
								</section>
							))}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
