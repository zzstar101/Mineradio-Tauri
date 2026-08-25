import { expect, test } from "bun:test";
import type { Track } from "@mineradio/shared";
import type { MusicServices } from "./music-services";

export const conformanceTrack: Track = {
	provider: "netease",
	id: "track-1",
	sourceId: "track-1",
	title: "测试歌曲",
	artists: ["测试歌手"],
	album: "测试专辑",
	coverUrl: "https://example.com/cover.jpg",
	qualityHints: [],
	playableState: "playable",
	durationMs: 180_000,
};

export type MusicServiceOperation =
	| "search.search"
	| "search.searchAll"
	| "search.podcastSearch"
	| "search.podcastHot"
	| "search.podcastPrograms"
	| "playback.songUrl"
	| "playback.resolveSongUrl"
	| "playback.trackQualities"
	| "lyrics.lyric"
	| "accounts.loginStatus"
	| "accounts.createLoginQrKey"
	| "accounts.createLoginQrImage"
	| "accounts.checkLoginQr"
	| "accounts.setSessionCookie"
	| "accounts.clearSessionCookie"
	| "accounts.logout"
	| "library.playlistList"
	| "library.playlistDetail"
	| "library.importSharedPlaylist"
	| "library.addSongToPlaylist"
	| "likes.likeSong"
	| "likes.checkSongLikes"
	| "discover.weatherRadio"
	| "discover.discoverHome"
	| "discover.recommendationPages"
	| "discover.streamNext"
	| "discover.podcastDetail"
	| "discover.podcastMy"
	| "discover.podcastMyItems"
	| "discover.podcastDjBeatmap";

export interface MusicServiceCall {
	operation: MusicServiceOperation;
	args: unknown[];
}

export interface MusicServicesConformanceHarness {
	services: MusicServices;
	calls: MusicServiceCall[];
}

export type MusicServicesConformanceHarnessFactory = (options: {
	result?: unknown;
	error?: unknown;
}) => MusicServicesConformanceHarness;

interface ConformanceScenario {
	name: string;
	operation: MusicServiceOperation;
	expectedArgs: unknown[];
	invoke(services: MusicServices): Promise<unknown>;
}

export const musicServicesConformanceScenarios: readonly ConformanceScenario[] = [
	{
		name: "search applies the public default limit",
		operation: "search.search",
		expectedArgs: ["netease", "测试", 30],
		invoke: (services) => services.search.search("netease", "测试"),
	},
	{
		name: "searchAll applies the default limit and preserves provider argument order",
		operation: "search.searchAll",
		expectedArgs: ["测试", 30, "qq"],
		invoke: (services) => services.search.searchAll("测试", undefined, "qq"),
	},
	{
		name: "podcastSearch preserves the default limit",
		operation: "search.podcastSearch",
		expectedArgs: ["播客", 18],
		invoke: (services) => services.search.podcastSearch("播客"),
	},
	{
		name: "podcastHot preserves the default window",
		operation: "search.podcastHot",
		expectedArgs: [18, 0],
		invoke: (services) => services.search.podcastHot(),
	},
	{
		name: "podcastPrograms preserves the default window",
		operation: "search.podcastPrograms",
		expectedArgs: ["radio-1", 30, 0],
		invoke: (services) => services.search.podcastPrograms("radio-1"),
	},
	{
		name: "songUrl preserves track and quality order",
		operation: "playback.songUrl",
		expectedArgs: [conformanceTrack, "lossless"],
		invoke: (services) => services.playback.songUrl(conformanceTrack, "lossless"),
	},
	{
		name: "resolveSongUrl preserves an omitted quality",
		operation: "playback.resolveSongUrl",
		expectedArgs: [conformanceTrack, undefined],
		invoke: (services) => services.playback.resolveSongUrl(conformanceTrack),
	},
	{
		name: "trackQualities preserves track identity",
		operation: "playback.trackQualities",
		expectedArgs: [conformanceTrack],
		invoke: (services) => services.playback.trackQualities(conformanceTrack),
	},
	{
		name: "lyric preserves track identity",
		operation: "lyrics.lyric",
		expectedArgs: [conformanceTrack],
		invoke: (services) => services.lyrics.lyric(conformanceTrack),
	},
	{
		name: "loginStatus preserves provider",
		operation: "accounts.loginStatus",
		expectedArgs: ["netease"],
		invoke: (services) => services.accounts.loginStatus("netease"),
	},
	{
		name: "createLoginQrKey preserves provider",
		operation: "accounts.createLoginQrKey",
		expectedArgs: ["qq"],
		invoke: (services) => services.accounts.createLoginQrKey("qq"),
	},
	{
		name: "createLoginQrImage preserves provider and key order",
		operation: "accounts.createLoginQrImage",
		expectedArgs: ["qq", "qr-key"],
		invoke: (services) => services.accounts.createLoginQrImage("qq", "qr-key"),
	},
	{
		name: "checkLoginQr preserves provider and key order",
		operation: "accounts.checkLoginQr",
		expectedArgs: ["qq", "qr-key"],
		invoke: (services) => services.accounts.checkLoginQr("qq", "qr-key"),
	},
	{
		name: "setSessionCookie preserves provider and cookie order",
		operation: "accounts.setSessionCookie",
		expectedArgs: ["soda", "session=测试"],
		invoke: (services) => services.accounts.setSessionCookie("soda", "session=测试"),
	},
	{
		name: "clearSessionCookie preserves provider",
		operation: "accounts.clearSessionCookie",
		expectedArgs: ["soda"],
		invoke: (services) => services.accounts.clearSessionCookie("soda"),
	},
	{
		name: "logout preserves provider",
		operation: "accounts.logout",
		expectedArgs: ["netease"],
		invoke: (services) => services.accounts.logout("netease"),
	},
	{
		name: "playlistList preserves provider",
		operation: "library.playlistList",
		expectedArgs: ["qq"],
		invoke: (services) => services.library.playlistList("qq"),
	},
	{
		name: "playlistDetail preserves provider and id order",
		operation: "library.playlistDetail",
		expectedArgs: ["netease", "playlist-1"],
		invoke: (services) => services.library.playlistDetail("netease", "playlist-1"),
	},
	{
		name: "streamNext preserves provider and stream card id order",
		operation: "discover.streamNext",
		expectedArgs: ["qq", "22000"],
		invoke: (services) => services.discover.streamNext("qq", "22000"),
	},
	{
		name: "importSharedPlaylist preserves the request object",
		operation: "library.importSharedPlaylist",
		expectedArgs: [{ text: "https://example.com/shared/playlist" }],
		invoke: (services) => services.library.importSharedPlaylist({
			text: "https://example.com/shared/playlist",
		}),
	},
	{
		name: "addSongToPlaylist preserves provider playlist and track order",
		operation: "library.addSongToPlaylist",
		expectedArgs: ["netease", "playlist-1", "track-1"],
		invoke: (services) => services.library.addSongToPlaylist(
			"netease",
			"playlist-1",
			"track-1",
		),
	},
	{
		name: "likeSong preserves provider id and liked order",
		operation: "likes.likeSong",
		expectedArgs: ["netease", "track-1", true],
		invoke: (services) => services.likes.likeSong("netease", "track-1", true),
	},
	{
		name: "checkSongLikes preserves the ids array",
		operation: "likes.checkSongLikes",
		expectedArgs: ["netease", ["track-1", "track-2"]],
		invoke: (services) => services.likes.checkSongLikes(
			"netease",
			["track-1", "track-2"],
		),
	},
	{
		name: "weatherRadio preserves the default query",
		operation: "discover.weatherRadio",
		expectedArgs: [{}],
		invoke: (services) => services.discover.weatherRadio(),
	},
	{
		name: "discoverHome delegates without arguments",
		operation: "discover.discoverHome",
		expectedArgs: [],
		invoke: (services) => services.discover.discoverHome(),
	},
	{
		name: "recommendationPages preserves the refresh default",
		operation: "discover.recommendationPages",
		expectedArgs: [{}],
		invoke: (services) => services.discover.recommendationPages(),
	},
	{
		name: "podcastDetail preserves id",
		operation: "discover.podcastDetail",
		expectedArgs: ["radio-1"],
		invoke: (services) => services.discover.podcastDetail("radio-1"),
	},
	{
		name: "podcastMy delegates without arguments",
		operation: "discover.podcastMy",
		expectedArgs: [],
		invoke: (services) => services.discover.podcastMy(),
	},
	{
		name: "podcastMyItems preserves the default window",
		operation: "discover.podcastMyItems",
		expectedArgs: ["created", 36, 0],
		invoke: (services) => services.discover.podcastMyItems("created"),
	},
	{
		name: "podcastDjBeatmap preserves the timing defaults",
		operation: "discover.podcastDjBeatmap",
		expectedArgs: ["https://example.com/podcast.mp3?name=测试", 0, 0],
		invoke: (services) => services.discover.podcastDjBeatmap(
			"https://example.com/podcast.mp3?name=测试",
		),
	},
];

function musicServiceLeafOperations(services: MusicServices): string[] {
	return Object.entries(services).flatMap(([domain, port]) => (
		Object.entries(port as unknown as Record<string, unknown>)
			.filter(([, value]) => typeof value === "function")
			.map(([method]) => `${domain}.${method}`)
	)).sort();
}

export function runMusicServicesConformance(
	adapterName: string,
	createHarness: MusicServicesConformanceHarnessFactory,
): void {
	for (const scenario of musicServicesConformanceScenarios) {
		test(`${adapterName}: ${scenario.name}`, async () => {
			const result = Object.freeze({ operation: scenario.operation });
			const success = createHarness({ result });

			expect(await scenario.invoke(success.services)).toBe(result);
			expect(success.calls).toEqual([{
				operation: scenario.operation,
				args: scenario.expectedArgs,
			}]);

			const error = Object.assign(new Error("当前歌曲不可播放"), {
				code: "PLAYBACK_RESTRICTED",
				provider: "qq",
				retryable: true,
				action: "refresh-key",
				playbackKeyReady: false,
				restriction: { category: "login_required" },
				reason: "key-expired",
				qqCode: 104003,
				rawMessage: "provider raw message",
				tried: ["qq", "netease"],
			});
			const failure = createHarness({ error });
			let caught: unknown;
			try {
				await scenario.invoke(failure.services);
			} catch (caughtError) {
				caught = caughtError;
			}

			expect(caught).toBe(error);
			expect(failure.calls).toEqual([{
				operation: scenario.operation,
				args: scenario.expectedArgs,
			}]);
		});
	}

	test(`${adapterName}: conformance covers all 30 MusicServices methods`, () => {
		const covered = musicServicesConformanceScenarios
			.map((scenario) => scenario.operation)
			.sort();
		const exposed = musicServiceLeafOperations(createHarness({ result: {} }).services);
		expect(covered.length).toBe(30);
		expect(new Set(covered).size).toBe(30);
		expect(covered).toEqual(exposed);
	});
}
