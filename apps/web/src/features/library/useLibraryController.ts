import { useCallback, useMemo, useRef, useState } from "react";
import {
	ProviderIdSchema,
	type PlaylistDetail,
	type PlaylistSummary,
	type PodcastCollection,
	type ProviderId,
	type Track,
} from "@mineradio/shared";
import type { LibraryPort } from "../../ports/music/library-port";
import type { DiscoverPort } from "../../ports/music/discover-port";
import type { PlaylistPanelTab } from "../../components/shell/PlaylistPanelHost";
import type { ShelfPlayPlaylistPayload } from "../../visual/shelf-pointer-interactions";
import { isPlayable } from "../../components/search/play-search-result";
import {
	mapPodcastItemsToShelfRows,
	mapShelfDetailRowToTrack,
} from "../../visual/shelf-detail-data";
import {
	importedPlaylistFromResult,
	readImportedPlaylistsFromStorage,
	saveImportedPlaylistsToStorage,
	upsertImportedPlaylist,
	type ImportedPlaylistRecord,
} from "../../shared-playlist/imported-playlists";
import {
	collectUnsupportedMessage,
	isCollectSupportedTrack,
	isLibraryLoginRequiredError,
	mergeProviderPlaylists,
} from "./library-policy";

const LIBRARY_PROVIDERS: ProviderId[] = ["netease", "qq", "soda"];

export interface LibraryPlaybackActions {
	setQueue(tracks: Track[]): void;
	playAt(index: number): void;
	enterPlaybackSurface(): void;
}

export interface ImportedPlaylistStorage {
	read(): ImportedPlaylistRecord[];
	save(playlists: ImportedPlaylistRecord[]): void;
}

export interface LibraryControllerResult {
	playlists: PlaylistSummary[];
	importedPlaylists: ImportedPlaylistRecord[];
	podcastCollections: PodcastCollection[];
	panelOpen: boolean;
	panelTab: PlaylistPanelTab;
	setPanelOpen(open: boolean): void;
	setPanelTab(tab: PlaylistPanelTab): void;
	openPanelTab(tab: PlaylistPanelTab): void;
	collectTarget: Track | null;
	collectBusyPlaylistId: string | null;
	writableCollectPlaylists: PlaylistSummary[];
	refresh(libraryOverride?: LibraryPort | null, discoverOverride?: DiscoverPort | null): Promise<void>;
	refreshProvider(provider: ProviderId, libraryOverride?: LibraryPort | null): Promise<PlaylistSummary[]>;
	openCollectPicker(track: Track): void;
	openCollectPickerForCurrent(): void;
	closeCollectPicker(): void;
	collectToPlaylist(playlistId: string): Promise<void>;
	importSharedPlaylist(text: string): Promise<void>;
	deleteImportedPlaylist(key: string): void;
	loadPlaylistDetail(playlist: PlaylistSummary): Promise<PlaylistDetail>;
	playTracks(tracks: Track[], index: number, title?: string): void;
	openPodcastCollection(collection: PodcastCollection): Promise<void>;
	playShelfPlaylist(payload: ShelfPlayPlaylistPayload): Promise<void>;
}

const defaultStorage: ImportedPlaylistStorage = {
	read: readImportedPlaylistsFromStorage,
	save: saveImportedPlaylistsToStorage,
};

export function useLibraryController({
	library,
	discover,
	getCurrentTrack,
	playback,
	searchQuery,
	openLogin,
	resetSearch,
	setSearchError,
	showToast,
	storage = defaultStorage,
}: {
	library: LibraryPort | null;
	discover: DiscoverPort | null;
	getCurrentTrack(): Track | null;
	playback: LibraryPlaybackActions;
	searchQuery(keyword: string, mode?: "song" | "podcast"): void;
	openLogin(): void;
	resetSearch(): void;
	setSearchError(message: string): void;
	showToast(message: string): void;
	storage?: ImportedPlaylistStorage;
}): LibraryControllerResult {
	const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
	const [importedPlaylists, setImportedPlaylists] = useState(storage.read);
	const [podcastCollections, setPodcastCollections] = useState<PodcastCollection[]>([]);
	const [panelOpen, setPanelOpen] = useState(false);
	const [panelTab, setPanelTab] = useState<PlaylistPanelTab>("queue");
	const [collectTarget, setCollectTarget] = useState<Track | null>(null);
	const [collectBusyPlaylistId, setCollectBusyPlaylistId] = useState<string | null>(null);
	const collectTargetRef = useRef(collectTarget);
	const collectBusyRef = useRef(collectBusyPlaylistId);
	const dependenciesRef = useRef({
		library,
		discover,
		getCurrentTrack,
		playback,
		searchQuery,
		openLogin,
		resetSearch,
		setSearchError,
		showToast,
		storage,
	});
	collectTargetRef.current = collectTarget;
	collectBusyRef.current = collectBusyPlaylistId;
	dependenciesRef.current = {
		library,
		discover,
		getCurrentTrack,
		playback,
		searchQuery,
		openLogin,
		resetSearch,
		setSearchError,
		showToast,
		storage,
	};

	const refresh = useCallback(
		async (
			libraryOverride?: LibraryPort | null,
			discoverOverride?: DiscoverPort | null,
		) => {
			const currentLibrary = libraryOverride ?? dependenciesRef.current.library;
			const currentDiscover = discoverOverride ?? dependenciesRef.current.discover;
			if (!currentLibrary) {
				setPlaylists([]);
				setPodcastCollections([]);
				return;
			}
			const results = await Promise.allSettled([
				...LIBRARY_PROVIDERS.map((provider) =>
					Promise.resolve().then(() => currentLibrary.playlistList(provider)),
				),
				currentDiscover
					? Promise.resolve().then(() => currentDiscover.podcastMy())
					: Promise.resolve(null),
			]);
			setPlaylists(
				results.slice(0, LIBRARY_PROVIDERS.length).flatMap((result) =>
					result.status === "fulfilled" ? (result.value as PlaylistSummary[]) : [],
				),
			);
			const podcastResult = results[LIBRARY_PROVIDERS.length];
			const podcastValue =
				podcastResult?.status === "fulfilled" ? podcastResult.value : null;
			setPodcastCollections(
				podcastValue && "loggedIn" in podcastValue && podcastValue.loggedIn
					? podcastValue.collections
					: [],
			);
		},
		[],
	);

	const refreshProvider = useCallback(
		async (provider: ProviderId, libraryOverride?: LibraryPort | null) => {
			const currentLibrary = libraryOverride ?? dependenciesRef.current.library;
			if (!currentLibrary) return [];
			const next = await currentLibrary.playlistList(provider);
			setPlaylists((current) => mergeProviderPlaylists(current, provider, next));
			return next;
		},
		[],
	);

	const openPanelTab = useCallback(
		(tab: PlaylistPanelTab) => {
			setPanelTab(tab);
			setPanelOpen(true);
			if (tab === "playlists" || tab === "podcasts") void refresh();
		},
		[refresh],
	);

	const openCollectPicker = useCallback(
		(track: Track) => {
			const current = dependenciesRef.current;
			if (!isCollectSupportedTrack(track)) {
				current.showToast(collectUnsupportedMessage(track));
				return;
			}
			if (!current.library) {
				current.showToast("API 未就绪，稍后再试");
				return;
			}
			collectTargetRef.current = track;
			collectBusyRef.current = null;
			setCollectTarget(track);
			setCollectBusyPlaylistId(null);
			void refresh();
		},
		[refresh],
	);

	const openCollectPickerForCurrent = useCallback(() => {
		const current = dependenciesRef.current;
		const track = current.getCurrentTrack();
		if (!track) {
			current.showToast("先播放或选择一首歌");
			return;
		}
		openCollectPicker(track);
	}, [openCollectPicker]);

	const closeCollectPicker = useCallback(() => {
		if (collectBusyRef.current) return;
		collectTargetRef.current = null;
		setCollectTarget(null);
	}, []);

	const collectToPlaylist = useCallback(
		async (playlistId: string) => {
			const current = dependenciesRef.current;
			const track = collectTargetRef.current;
			if (!current.library || !track || !playlistId || collectBusyRef.current) return;
			if (!isCollectSupportedTrack(track)) {
				current.showToast(collectUnsupportedMessage(track));
				collectTargetRef.current = null;
				setCollectTarget(null);
				return;
			}
			collectBusyRef.current = playlistId;
			setCollectBusyPlaylistId(playlistId);
			current.showToast("正在收藏到歌单...");
			try {
				await current.library.addSongToPlaylist(
					track.provider,
					playlistId,
					track.id,
				);
				current.showToast("已收藏到歌单");
				collectTargetRef.current = null;
				setCollectTarget(null);
				void refresh();
			} catch (error) {
				const message = isLibraryLoginRequiredError(error)
					? `登录后可同步到${track.provider === "qq" ? "QQ 音乐" : "网易云"}`
					: error instanceof Error
						? error.message
						: "收藏失败";
				current.showToast(message);
			} finally {
				collectBusyRef.current = null;
				setCollectBusyPlaylistId(null);
			}
		},
		[refresh],
	);

	const importSharedPlaylist = useCallback(async (text: string) => {
		const current = dependenciesRef.current;
		if (!current.library) {
			const message = "API 尚未就绪，稍后再试";
			current.setSearchError(message);
			current.showToast(message);
			throw new Error(message);
		}
		try {
			const result = await current.library.importSharedPlaylist({ text });
			setImportedPlaylists((previous) => {
				const key = `${result.provider}:${result.playlist.id}`;
				const oldRecord = previous.find((item) => item.key === key);
				const record = importedPlaylistFromResult(result, Date.now(), oldRecord);
				const next = upsertImportedPlaylist(previous, record);
				current.storage.save(next);
				return next;
			});
			current.resetSearch();
			setPanelTab("playlists");
			setPanelOpen(true);
			const total = result.trackCount || result.tracks.length;
			current.showToast(
				`已导入「${result.playlist.name}」 · ${result.loadedCount}/${total} 首`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "歌单导入失败";
			current.setSearchError(message);
			current.showToast(message);
			throw error;
		}
	}, []);

	const deleteImportedPlaylist = useCallback((key: string) => {
		const current = dependenciesRef.current;
		setImportedPlaylists((previous) => {
			const next = previous.filter((item) => item.key !== key);
			current.storage.save(next);
			return next;
		});
		current.showToast("已删除导入歌单");
	}, []);

	const loadPlaylistDetail = useCallback(async (playlist: PlaylistSummary) => {
		const currentLibrary = dependenciesRef.current.library;
		if (!currentLibrary) return { ...playlist, tracks: [] };
		return currentLibrary.playlistDetail(playlist.provider, playlist.id);
	}, []);

	const playTracks = useCallback((tracks: Track[], index: number, title?: string) => {
		const current = dependenciesRef.current;
		if (!tracks.length) {
			current.showToast("歌单暂时没有可播放歌曲");
			return;
		}
		const safeIndex = Math.max(0, Math.min(index, tracks.length - 1));
		current.playback.setQueue(tracks);
		current.playback.playAt(safeIndex);
		setPanelTab("queue");
		current.playback.enterPlaybackSurface();
		if (title) current.showToast(title);
	}, []);

	const openPodcastCollection = useCallback(
		async (collection: PodcastCollection) => {
			const current = dependenciesRef.current;
			if (!current.discover) {
				current.searchQuery(collection.title || "播客", "podcast");
				return;
			}
			try {
				const detail = await current.discover.podcastMyItems(collection.key, 36, 0);
				if (!detail.loggedIn) {
					current.openLogin();
					return;
				}
				const playable = detail.items.flatMap((item) => {
					if (!("provider" in item) || !("title" in item)) return [];
					const track = item as Track;
					return isPlayable(track.playableState) ? [track] : [];
				});
				if (playable.length) {
					playTracks(playable, 0, detail.title || collection.title);
					return;
				}
				current.searchQuery(detail.title || collection.title || "播客", "podcast");
			} catch (error) {
				current.showToast(error instanceof Error ? error.message : "播客加载失败");
			}
		},
		[playTracks],
	);

	const playShelfPlaylist = useCallback(
		async (payload: ShelfPlayPlaylistPayload) => {
			const current = dependenciesRef.current;
			if (!current.library) {
				current.showToast("API 未就绪，稍后再试");
				return;
			}
			const playlistId = String(payload.playlistId || "").trim();
			if (!playlistId) {
				current.showToast("歌单信息不完整");
				return;
			}
			try {
				let tracks: Track[] = [];
				let title = payload.title || "歌单";
				if (playlistId.startsWith("podcast:")) {
					const key = playlistId.slice("podcast:".length);
					if (!key || !current.discover) {
						current.showToast("播客信息不完整");
						return;
					}
					const detail = await current.discover.podcastMyItems(key, 36, 0);
					tracks = mapPodcastItemsToShelfRows(detail)
						.map(mapShelfDetailRowToTrack)
						.filter(
							(track): track is Track =>
								!!track && isPlayable(track.playableState),
						);
					title = detail.title || title;
				} else {
					const provider = ProviderIdSchema.safeParse(payload.provider);
					if (!provider.success) {
						current.showToast("歌单信息不完整");
						return;
					}
					const detail = await current.library.playlistDetail(provider.data, playlistId);
					tracks = detail.tracks;
					title = detail.name || title;
				}
				playTracks(tracks, 0, title);
			} catch (error) {
				current.showToast(error instanceof Error ? error.message : "歌单载入失败");
			}
		},
		[playTracks],
	);

	const writableCollectPlaylists = useMemo(
		() =>
			collectTarget
				? playlists.filter(
						(playlist) =>
							playlist.provider === collectTarget.provider &&
							playlist.subscribed !== true,
					)
				: [],
		[collectTarget, playlists],
	);

	return {
		playlists,
		importedPlaylists,
		podcastCollections,
		panelOpen,
		panelTab,
		setPanelOpen,
		setPanelTab,
		openPanelTab,
		collectTarget,
		collectBusyPlaylistId,
		writableCollectPlaylists,
		refresh,
		refreshProvider,
		openCollectPicker,
		openCollectPickerForCurrent,
		closeCollectPicker,
		collectToPlaylist,
		importSharedPlaylist,
		deleteImportedPlaylist,
		loadPlaylistDetail,
		playTracks,
		openPodcastCollection,
		playShelfPlaylist,
	};
}
