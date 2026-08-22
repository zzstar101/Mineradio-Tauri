import type { SidecarClient } from "../../api/sidecar-client";
import type { MusicServices } from "../../ports/music/music-services";

export function createLegacySidecarServices(client: SidecarClient): MusicServices {
	return {
		search: {
			search: (provider, keyword, limit = 30) => client.search(provider, keyword, limit),
			searchAll: (keyword, limit = 30, provider) => client.searchAll(keyword, limit, provider),
			podcastSearch: (keywords, limit) => client.podcastSearch(keywords, limit),
			podcastHot: (limit, offset) => client.podcastHot(limit, offset),
			podcastPrograms: (id, limit, offset) => client.podcastPrograms(id, limit, offset),
		},
		playback: {
			songUrl: (track, quality) => client.songUrl(track, quality),
			resolveSongUrl: (track, quality) => client.resolveSongUrl(track, quality),
			trackQualities: (track) => client.trackQualities(track),
		},
		lyrics: {
			lyric: (track) => client.lyric(track),
		},
		accounts: {
			loginStatus: (provider) => client.loginStatus(provider),
			createLoginQrKey: (provider, kind) => client.createProviderLoginQrKey(provider, kind),
			createLoginQrImage: (provider, key, kind) => client.createProviderLoginQrImage(provider, key, kind),
			checkLoginQr: (provider, key, kind) => client.checkProviderLoginQr(provider, key, kind),
			setSessionCookie: (provider, cookie) => client.setProviderSessionCookie(provider, cookie),
			clearSessionCookie: (provider) => client.clearProviderSessionCookie(provider),
			logout: (provider) => client.logout(provider),
		},
		library: {
			playlistList: (provider) => client.playlistList(provider),
			playlistDetail: (provider, id) => client.playlistDetail(provider, id),
			importSharedPlaylist: (input) => client.importSharedPlaylist(input),
			addSongToPlaylist: (provider, playlistId, trackId) => (
				client.addSongToPlaylist(provider, playlistId, trackId)
			),
		},
		likes: {
			likeSong: (provider, id, liked) => client.likeSong(provider, id, liked),
			checkSongLikes: (provider, ids) => client.checkSongLikes(provider, ids),
		},
		discover: {
			weatherRadio: (params) => client.weatherRadio(params),
			discoverHome: () => client.discoverHome(),
			recommendationPages: (options) => client.recommendationPages(options),
			podcastDetail: (id) => client.podcastDetail(id),
			podcastMy: () => client.podcastMy(),
			podcastMyItems: (key, limit, offset) => client.podcastMyItems(key, limit, offset),
			podcastDjBeatmap: (url, durationSec, introSec) => (
				client.podcastDjBeatmap(url, durationSec, introSec)
			),
		},
	};
}
