import type { SidecarClient } from "../../api/sidecar-client";
import {
	runMusicServicesConformance,
	type MusicServiceCall,
	type MusicServiceOperation,
	type MusicServicesConformanceHarness,
} from "../../ports/music/music-services.conformance";
import { createLegacySidecarServices } from "./legacy-sidecar-services";

const legacyMethodOperations = {
	search: "search.search",
	searchAll: "search.searchAll",
	podcastSearch: "search.podcastSearch",
	podcastHot: "search.podcastHot",
	podcastPrograms: "search.podcastPrograms",
	songUrl: "playback.songUrl",
	resolveSongUrl: "playback.resolveSongUrl",
	trackQualities: "playback.trackQualities",
	lyric: "lyrics.lyric",
	loginStatus: "accounts.loginStatus",
	createProviderLoginQrKey: "accounts.createLoginQrKey",
	createProviderLoginQrImage: "accounts.createLoginQrImage",
	checkProviderLoginQr: "accounts.checkLoginQr",
	setProviderSessionCookie: "accounts.setSessionCookie",
	clearProviderSessionCookie: "accounts.clearSessionCookie",
	logout: "accounts.logout",
	playlistList: "library.playlistList",
	playlistDetail: "library.playlistDetail",
	importSharedPlaylist: "library.importSharedPlaylist",
	addSongToPlaylist: "library.addSongToPlaylist",
	likeSong: "likes.likeSong",
	checkSongLikes: "likes.checkSongLikes",
	weatherRadio: "discover.weatherRadio",
	discoverHome: "discover.discoverHome",
	recommendationPages: "discover.recommendationPages",
	streamNext: "discover.streamNext",
	podcastDetail: "discover.podcastDetail",
	podcastMy: "discover.podcastMy",
	podcastMyItems: "discover.podcastMyItems",
	podcastDjBeatmap: "discover.podcastDjBeatmap",
} as const satisfies Partial<Record<keyof SidecarClient, MusicServiceOperation>>;

type LegacyMusicMethod = keyof typeof legacyMethodOperations;

const sidecarDefaults: Partial<Record<LegacyMusicMethod, Readonly<Record<number, unknown>>>> = {
	weatherRadio: { 0: {} },
	podcastSearch: { 1: 18 },
	podcastHot: { 0: 18, 1: 0 },
	podcastPrograms: { 1: 30, 2: 0 },
	podcastMyItems: { 1: 36, 2: 0 },
	podcastDjBeatmap: { 1: 0, 2: 0 },
	recommendationPages: { 0: {} },
};

function applySidecarDefaults(method: LegacyMusicMethod, args: unknown[]): unknown[] {
	const normalized = [...args];
	for (const [rawIndex, defaultValue] of Object.entries(sidecarDefaults[method] ?? {})) {
		const index = Number(rawIndex);
		if (normalized[index] === undefined) normalized[index] = defaultValue;
	}
	return normalized;
}

function createLegacyHarness(options: {
	result?: unknown;
	error?: unknown;
}): MusicServicesConformanceHarness {
	const calls: MusicServiceCall[] = [];
	const client = new Proxy({}, {
		get(_target, property) {
			return (...args: unknown[]) => {
				const method = property as LegacyMusicMethod;
				const operation = legacyMethodOperations[method];
				if (!operation) throw new Error(`未登记的 legacy Sidecar 方法：${String(property)}`);
				calls.push({ operation, args: applySidecarDefaults(method, args) });
				return options.error === undefined
					? Promise.resolve(options.result)
					: Promise.reject(options.error);
			};
		},
	}) as SidecarClient;

	return {
		services: createLegacySidecarServices(client),
		calls,
	};
}

runMusicServicesConformance("legacy MusicServices conformance", createLegacyHarness);
