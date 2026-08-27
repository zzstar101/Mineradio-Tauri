import { useCallback, useState, type ReactElement } from "react";
import type { PlaybackMode } from "../../stores/playback-store";
import type {
	PlaylistDetail,
	PlaylistSummary,
	PodcastCollection,
	SharedPlaylistInfo,
	Track,
} from "@mineradio/shared";
import type { ImportedPlaylistRecord } from "../../shared-playlist/imported-playlists";
import { resolveVirtualListWindow } from "./virtual-list";

export type PlaylistPanelTab = "queue" | "playlists" | "podcasts";
const QUEUE_ROW_HEIGHT = 62;
const QUEUE_VIEWPORT_HEIGHT = 420;
const DETAIL_ROW_HEIGHT = 54;
const DETAIL_VIEWPORT_HEIGHT = 460;
const PODCAST_COLLECTION_ROW_HEIGHT = 62;
const PODCAST_COLLECTION_VIEWPORT_HEIGHT = 420;
type PlaylistDetailSummary = PlaylistSummary | SharedPlaylistInfo;

export interface PlaylistPanelHostProps {
	open: boolean;
	pinned?: boolean;
	tab: PlaylistPanelTab;
	queue: Track[];
	currentTrack: Track | null;
	mode: PlaybackMode;
	playlists: PlaylistSummary[];
	importedPlaylists?: ImportedPlaylistRecord[];
	podcastCollections: PodcastCollection[];
	onTabChange: (tab: PlaylistPanelTab) => void;
	onPinToggle?: () => void;
	onShuffle?: () => void;
	onCycleMode?: () => void;
	onClearQueue?: () => void;
	onRefresh?: () => void;
	onPlayQueueIndex?: (index: number) => void;
	onQueueArtist?: (artist: string, track: Track) => void;
	onLikeQueueIndex?: (index: number) => void;
	onCollectQueueIndex?: (index: number) => void;
	onInsertQueueNext?: (index: number) => void;
	onRemoveQueueIndex?: (index: number) => void;
	onLoadPlaylistDetail?: (playlist: PlaylistSummary) => Promise<PlaylistDetail>;
	onPlayTracks?: (tracks: Track[], index: number, title?: string) => void;
	onDeleteImportedPlaylist?: (key: string) => void;
	onPodcastCollectionOpen?: (collection: PodcastCollection) => void;
}

function trackKey(track: Track | null): string {
	return track ? `${track.provider}:${track.id}` : "";
}

function providerLabel(provider: string): string {
	if (provider === "qq") return "QQ 音乐";
	if (provider === "netease") return "网易云";
	if (provider === "kugou") return "酷狗音乐";
	if (provider === "qishui") return "汽水音乐";
	if (provider === "apple-music") return "Apple Music";
	return provider;
}

function modeLabel(mode: PlaybackMode): string {
	if (mode === "single") return "单曲循环";
	if (mode === "shuffle") return "随机播放";
	if (mode === "queue") return "顺序播放";
	return "顺序循环";
}

function coverNode(url: string | undefined, className = ""): ReactElement {
	return url ? <img className={className || undefined} src={url} alt="" loading="lazy" decoding="async" /> : <div className={className || undefined} style={{ width: 44, height: 44, borderRadius: 8, background: "rgba(255,255,255,.06)", flexShrink: 0 }} />;
}

function detailKey(playlist: PlaylistDetailSummary): string {
	return `${playlist.provider}:${playlist.id}`;
}

function importedDetailKey(record: ImportedPlaylistRecord): string {
	return `imported:${record.key}`;
}

export function PlaylistPanelHost(props: PlaylistPanelHostProps): ReactElement {
	const [queueScrollTop, setQueueScrollTop] = useState(0);
	const [detailScrollTop, setDetailScrollTop] = useState(0);
	const [podcastScrollTop, setPodcastScrollTop] = useState(0);
	const [detail, setDetail] = useState<{
		key: string;
		playlist: PlaylistDetailSummary;
		loading: boolean;
		tracks: Track[];
		partialReason?: string;
	} | null>(null);

	const openDetail = useCallback(async (playlist: PlaylistSummary) => {
		const key = detailKey(playlist);
		if (detail?.key === key && !detail.loading) {
			setDetail(null);
			return;
		}
		setDetailScrollTop(0);
		setDetail({ key, playlist, loading: true, tracks: [] });
		try {
			const loaded = await props.onLoadPlaylistDetail?.(playlist);
			setDetail((state) =>
				state?.key === key
					? { key, playlist: loaded ?? playlist, loading: false, tracks: loaded?.tracks ?? [] }
					: state,
			);
		} catch {
			setDetail((state) =>
				state?.key === key ? { ...state, loading: false, tracks: [] } : state,
			);
		}
	}, [detail, props]);

	const openImportedDetail = useCallback((record: ImportedPlaylistRecord) => {
		const key = importedDetailKey(record);
		if (detail?.key === key && !detail.loading) {
			setDetail(null);
			return;
		}
		setDetailScrollTop(0);
		setDetail({
			key,
			playlist: record.playlist,
			loading: false,
			tracks: record.tracks,
			partialReason: record.partial ? record.partialReason : undefined,
		});
	}, [detail]);

	const renderQueue = () => {
		const window = resolveVirtualListWindow({
			itemCount: props.queue.length,
			rowHeight: QUEUE_ROW_HEIGHT,
			viewportHeight: QUEUE_VIEWPORT_HEIGHT,
			scrollTop: queueScrollTop,
		});
		const visibleQueue = props.queue.slice(window.startIndex, window.endIndex);
		const virtualStyle = window.virtualized
			? {
				maxHeight: QUEUE_VIEWPORT_HEIGHT,
				overflowY: "auto" as const,
				paddingTop: window.paddingTop,
				paddingBottom: window.paddingBottom,
			}
			: undefined;
		return (
			<div id="queue-pane">
			<div className="queue-toolbar">
				<div id="play-mode-chip" className="queue-chip">{modeLabel(props.mode)}</div>
				<div className="queue-toolbar-actions">
					<button className="fx-mini-btn ghost" type="button" onClick={props.onCycleMode}>切换模式</button>
					<button className="fx-mini-btn ghost" type="button" onClick={props.onClearQueue}>清空</button>
				</div>
			</div>
			<div
				id="queue-list"
				className="queue-list"
				data-virtualized={window.virtualized ? "true" : undefined}
				onScroll={(event) => setQueueScrollTop(event.currentTarget.scrollTop)}
				style={virtualStyle}
			>
				{props.queue.length === 0 ? (
					<div className="playlist-empty">队列为空，搜索后点 + 设为下一首</div>
				) : visibleQueue.map((track, localIndex) => {
					const index = window.startIndex + localIndex;
					const now = trackKey(track) === trackKey(props.currentTrack);
					const artist = track.artists.join(" / ") || "未知歌手";
					return (
						<div key={`${track.provider}:${track.id}:${index}`} className={now ? "queue-item now" : "queue-item"} onClick={() => props.onPlayQueueIndex?.(index)}>
							{coverNode(track.coverUrl, "queue-cover")}
							<div className="qi-info">
								<div className="qi-name">{track.title}</div>
								<div className="qi-sub">
									<button className="queue-artist-link" type="button" onClick={(event) => {
										event.stopPropagation();
										props.onQueueArtist?.(artist, track);
									}}>{artist}</button>
								</div>
							</div>
							<div className="qi-act">
								<button type="button" onClick={(event) => { event.stopPropagation(); props.onLikeQueueIndex?.(index); }} title="红心喜欢">♡</button>
								<button className="queue-next" type="button" onClick={(event) => { event.stopPropagation(); props.onInsertQueueNext?.(index); }} title="下一首播放">下</button>
								<button type="button" onClick={(event) => { event.stopPropagation(); props.onCollectQueueIndex?.(index); }} title="收藏到歌单">＋</button>
								<button type="button" onClick={(event) => { event.stopPropagation(); props.onRemoveQueueIndex?.(index); }} title="移除">×</button>
							</div>
						</div>
					);
				})}
			</div>
		</div>
		);
	};

	const renderPlaylistDetail = (playlist: PlaylistDetailSummary, keyOverride?: string) => {
		if (!detail || detail.key !== (keyOverride ?? detailKey(playlist))) return null;
		const tracks = detail.tracks;
		const window = resolveVirtualListWindow({
			itemCount: tracks.length,
			rowHeight: DETAIL_ROW_HEIGHT,
			viewportHeight: DETAIL_VIEWPORT_HEIGHT,
			scrollTop: detailScrollTop,
		});
		const visibleTracks = tracks.slice(window.startIndex, window.endIndex);
		const virtualStyle = window.virtualized
			? {
				maxHeight: DETAIL_VIEWPORT_HEIGHT,
				overflowY: "auto" as const,
				paddingTop: window.paddingTop,
				paddingBottom: window.paddingBottom,
			}
			: undefined;
		return (
			<div className="pl-inline-detail" data-pl-detail={detail.key}>
				<div className="pl-detail-sticky">
					<div className="pl-detail-head">
						{coverNode((detail.playlist as PlaylistSummary).coverUrl, "pl-detail-cover")}
						<div className="pl-detail-title-wrap">
							<div className="pl-detail-title">{detail.playlist.name || "歌单详情"}</div>
							<div className="pl-detail-sub">{(detail.playlist.trackCount ?? tracks.length) || 0} 首</div>
						</div>
						<div className="pl-detail-count">{detail.loading ? "载入中" : `${tracks.length}/${tracks.length}`}</div>
					</div>
					{detail.partialReason ? <div className="pl-detail-partial">{detail.partialReason}</div> : null}
					<div className="pl-detail-actions">
						<button className="pl-detail-play" type="button" disabled={!tracks.length} onClick={() => props.onPlayTracks?.(tracks, 0, detail.playlist.name)}>
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>播放歌单
						</button>
					</div>
				</div>
				<div
					className="pl-detail-list"
					data-virtualized={window.virtualized ? "true" : undefined}
					onScroll={(event) => setDetailScrollTop(event.currentTarget.scrollTop)}
					style={virtualStyle}
				>
					{detail.loading ? (
						<div className="pl-detail-row"><div className="pl-detail-row-title">正在载入歌单</div></div>
					) : tracks.length === 0 ? (
						<div className="playlist-empty">{detail.partialReason || "歌单暂无可播放歌曲"}</div>
					) : visibleTracks.map((track, localIndex) => {
						const index = window.startIndex + localIndex;
						return (
						<div className="pl-detail-row" data-pl-detail-row={index} key={`${track.provider}:${track.id}:${index}`} onClick={() => props.onPlayTracks?.(tracks, index, detail.playlist.name)}>
							{coverNode(track.coverUrl, "pl-detail-row-cover")}
							<div className="pl-detail-row-main">
								<div className="pl-detail-row-title">{track.title}</div>
								<button className="pl-detail-row-artist" type="button" onClick={(event) => {
									event.stopPropagation();
									props.onQueueArtist?.(track.artists.join(" / ") || "未知歌手", track);
								}}>{track.artists.join(" / ") || "未知歌手"}</button>
							</div>
						</div>
					);
					})}
				</div>
			</div>
		);
	};

	const renderPlaylists = () => {
		const imported = props.importedPlaylists ?? [];
		const groups = [
			{ key: "netease", label: "网易云歌单", items: props.playlists.filter((playlist) => playlist.provider === "netease") },
			{ key: "qq", label: "QQ 音乐歌单", items: props.playlists.filter((playlist) => playlist.provider === "qq") },
			{ key: "soda", label: "汽水音乐歌单", items: props.playlists.filter((playlist) => playlist.provider === "soda") },
		];
		return (
			<div id="pl-pane">
				<div className="queue-toolbar">
					<div className="queue-chip">登录后显示网易云 / QQ音乐 / 汽水音乐歌单</div>
					<button className="fx-mini-btn ghost" type="button" onClick={props.onRefresh}>刷新</button>
				</div>
				<div id="pl-list">
					{imported.length ? (
						<div className="pl-section" key="imported">
							<div className="pl-section-label">已导入歌单</div>
							{imported.map((record) => {
								const key = importedDetailKey(record);
								const expanded = detail?.key === key;
								return (
									<div key={record.key}>
										<div className={expanded ? "pl-card imported expanded" : "pl-card imported"} data-playlist-provider={record.provider} data-playlist-id={record.playlist.id} onClick={() => openImportedDetail(record)}>
											{coverNode(record.playlist.coverUrl)}
											<div className="pl-card-main">
												<div className="pl-name">{record.playlist.name}<span className="tag-source imported">导入 · {providerLabel(record.provider)}</span></div>
												<div className="pl-sub">{record.loadedCount || record.tracks.length}/{record.trackCount || record.tracks.length} 首</div>
											</div>
											<button className="pl-card-delete" type="button" aria-label="删除导入歌单" title="删除导入歌单" onClick={(event) => {
												event.stopPropagation();
												props.onDeleteImportedPlaylist?.(record.key);
											}}>删除</button>
										</div>
										{renderPlaylistDetail(record.playlist, key)}
									</div>
								);
							})}
						</div>
					) : null}
					{props.playlists.length === 0 && imported.length === 0 ? <div className="playlist-empty">登录后显示个人歌单</div> : groups.map((group) => group.items.length ? (
						<div className="pl-section" key={group.key}>
							<div className="pl-section-label">{group.label}</div>
							{group.items.map((playlist) => {
								const expanded = detail?.key === detailKey(playlist);
								return (
									<div key={`${playlist.provider}:${playlist.id}`}>
										<div className={expanded ? "pl-card expanded" : "pl-card"} data-playlist-provider={playlist.provider} data-playlist-id={playlist.id} onClick={() => void openDetail(playlist)}>
											{coverNode(playlist.coverUrl)}
											<div className="pl-card-main">
												<div className="pl-name">{playlist.name}<span className={`tag-source ${playlist.provider}`}>{providerLabel(playlist.provider)}</span></div>
												<div className="pl-sub">{playlist.trackCount ?? 0} 首</div>
											</div>
										</div>
										{renderPlaylistDetail(playlist)}
									</div>
								);
							})}
						</div>
					) : null)}
				</div>
			</div>
		);
	};

	const renderPodcasts = () => {
		const window = resolveVirtualListWindow({
			itemCount: props.podcastCollections.length,
			rowHeight: PODCAST_COLLECTION_ROW_HEIGHT,
			viewportHeight: PODCAST_COLLECTION_VIEWPORT_HEIGHT,
			scrollTop: podcastScrollTop,
		});
		const visibleCollections = props.podcastCollections.slice(window.startIndex, window.endIndex);
		const virtualStyle = window.virtualized
			? {
				maxHeight: PODCAST_COLLECTION_VIEWPORT_HEIGHT,
				overflowY: "auto" as const,
				paddingTop: window.paddingTop,
				paddingBottom: window.paddingBottom,
			}
			: undefined;
		return (
			<div id="podcast-pane">
				<div className="queue-toolbar">
					<div className="queue-chip">收藏 / 创建 / 喜欢</div>
					<button className="fx-mini-btn ghost" type="button" onClick={props.onRefresh}>刷新</button>
				</div>
				<div
					id="podcast-list"
					data-virtualized={window.virtualized ? "true" : undefined}
					onScroll={(event) => setPodcastScrollTop(event.currentTarget.scrollTop)}
					style={virtualStyle}
				>
					{props.podcastCollections.length === 0 ? (
						<div className="playlist-empty">登录后显示我的播客</div>
					) : visibleCollections.map((collection) => (
						<div key={collection.key} className="pl-card podcast-card" data-podcast-key={collection.key} onClick={() => props.onPodcastCollectionOpen?.(collection)}>
							{coverNode(collection.coverUrl)}
							<div className="pl-card-main">
								<div className="pl-name">{collection.title}</div>
								<div className="pl-sub">{collection.count || 0} 项 · {collection.sub || (collection.itemType === "voice" ? "声音" : "播客")}</div>
							</div>
						</div>
					))}
				</div>
			</div>
		);
	};

	return (
		<div id="playlist-panel" className={`${props.open ? "show" : ""}${props.pinned ? " pinned" : ""}`.trim()}>
			<div className="queue-head">
				<div>
					<div className="fx-title">歌单 / 队列</div>
					<div className="fx-sub">QUEUE · 鼠标移开自动隐藏</div>
				</div>
				<div className="queue-head-act">
					<button id="playlist-pin-btn" className={props.pinned ? "fx-mini-btn ghost playlist-pin-btn active" : "fx-mini-btn ghost playlist-pin-btn"} type="button" onClick={props.onPinToggle} title={props.pinned ? "取消常开歌单" : "常开歌单"} aria-label={props.pinned ? "取消常开歌单" : "常开歌单"}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ display: "block", margin: "auto" }}>
							<path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
						</svg>
					</button>
					<button className="fx-mini-btn ghost" type="button" onClick={props.onShuffle}>随机</button>
				</div>
			</div>
			<div className="panel-tabs">
				<button id="tab-queue" className={props.tab === "queue" ? "panel-tab active" : "panel-tab"} type="button" onClick={() => props.onTabChange("queue")}>当前队列</button>
				<button id="tab-pl" className={props.tab === "playlists" ? "panel-tab active" : "panel-tab"} type="button" onClick={() => props.onTabChange("playlists")}>我的歌单</button>
				<button id="tab-podcast" className={props.tab === "podcasts" ? "panel-tab active" : "panel-tab"} type="button" onClick={() => props.onTabChange("podcasts")}>我的播客</button>
			</div>
			{props.tab === "queue" ? renderQueue() : null}
			{props.tab === "playlists" ? renderPlaylists() : null}
			{props.tab === "podcasts" ? renderPodcasts() : null}
		</div>
	);
}
