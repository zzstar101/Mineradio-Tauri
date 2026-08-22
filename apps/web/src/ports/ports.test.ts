import { expect, test } from "bun:test";
import type { Track } from "@mineradio/shared";
import "./music/music-services";
import type { MusicServices } from "./music/music-services";

const track: Track = {
	id: "track-1",
	sourceId: "track-1",
	provider: "netease",
	title: "测试歌曲",
	artists: ["测试歌手"],
	album: "测试专辑",
	durationMs: 180_000,
	coverUrl: "https://example.com/cover.jpg",
	qualityHints: [],
	playableState: "playable",
};

test("MusicServices keeps feature calls behind narrow ports", async () => {
	const calls: string[] = [];
	const unused = async (): Promise<never> => {
		throw new Error("未调用的测试端口");
	};
	const services = {
		search: {
			search: async (provider, keyword, limit = 30) => {
				calls.push(`search:${provider}:${keyword}:${limit}`);
				return [track];
			},
			searchAll: async (keyword, limit = 30, provider = undefined) => {
				calls.push(`search-all:${keyword}:${limit}:${provider ?? "all"}`);
				return [track];
			},
			podcastSearch: unused,
			podcastHot: unused,
			podcastPrograms: unused,
		},
		playback: {
			songUrl: unused,
			resolveSongUrl: unused,
			trackQualities: unused,
		},
		lyrics: {
			lyric: async (input) => {
				calls.push(`lyric:${input.id}`);
				return {
					provider: input.provider,
					trackId: input.id,
					lines: [],
					hasTranslation: false,
					isWordByWord: false,
				};
			},
		},
		accounts: {
			loginStatus: unused,
			createLoginQrKey: unused,
			createLoginQrImage: unused,
			checkLoginQr: unused,
			setSessionCookie: unused,
			clearSessionCookie: unused,
			logout: unused,
		},
		library: {
			playlistList: unused,
			playlistDetail: async (provider, id) => {
				calls.push(`playlist:${provider}:${id}`);
				return {
					id,
					provider,
					name: "测试歌单",
					coverUrl: "",
					trackCount: 1,
					trackIds: [track.id],
					subscribed: false,
					tracks: [track],
				};
			},
			importSharedPlaylist: unused,
			addSongToPlaylist: unused,
		},
		likes: {
			likeSong: unused,
			checkSongLikes: unused,
		},
		discover: {
			weatherRadio: unused,
			discoverHome: unused,
			recommendationPages: unused,
			podcastDetail: unused,
			podcastMy: unused,
			podcastMyItems: unused,
			podcastDjBeatmap: unused,
		},
	} satisfies MusicServices;

	await services.search.search("netease", "测试", 12);
	await services.search.searchAll("测试", 18);
	await services.lyrics.lyric(track);
	await services.library.playlistDetail("netease", "playlist-1");

	expect(calls).toEqual([
		"search:netease:测试:12",
		"search-all:测试:18:all",
		"lyric:track-1",
		"playlist:netease:playlist-1",
	]);
});
