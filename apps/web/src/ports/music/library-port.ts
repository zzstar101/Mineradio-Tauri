import type {
	PlaylistAddSongAck,
	PlaylistDetail,
	PlaylistSummary,
	ProviderId,
	SharedPlaylistImportRequest,
	SharedPlaylistImportResult,
} from "@mineradio/shared";

/** 歌单详情分页：offset 从 0 起，limit 单页数量；缺省由桥给默认值。 */
export interface PlaylistDetailPage {
	offset: number;
	limit: number;
}

export interface LibraryPort {
	playlistList(provider: ProviderId): Promise<PlaylistSummary[]>;
	playlistDetail(
		provider: ProviderId,
		id: string,
		page?: PlaylistDetailPage,
	): Promise<PlaylistDetail>;
	importSharedPlaylist(input: SharedPlaylistImportRequest): Promise<SharedPlaylistImportResult>;
	addSongToPlaylist(
		provider: ProviderId,
		playlistId: string,
		trackId: string,
	): Promise<PlaylistAddSongAck>;
}
