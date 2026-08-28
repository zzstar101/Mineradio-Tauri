import { expect, test } from "bun:test";
import type { PlaylistDetail, ProviderId, PodcastMyItemsResponse, PodcastProgramsResponse } from "@mineradio/shared";
import { usePlaybackStore } from "../stores/playback-store";
import {
	createPodcastRadioDetailOpener,
	createShelfDetailContentLoader,
	handleShelfDetailRowAction,
	mapPlaylistDetailToShelfRows,
	mapPodcastItemsToShelfRows,
	mapShelfDetailRowToTrack,
	playShelfDetailRow,
} from "./shelf-detail-data";

function makeDetail(): PlaylistDetail {
	return {
		provider: "netease",
		id: "daily",
		name: "Daily Mix",
		coverUrl: "https://example.invalid/cover.jpg",
		trackIds: [],
		subscribed: false,
		tracks: [
			{
				provider: "netease",
				id: "song-1",
				sourceId: "song-1",
				title: "First Song",
				artists: ["Alice", "Bob"],
				album: "First Album",
				coverUrl: "https://example.invalid/first.jpg",
				durationMs: 201_000,
				qualityHints: ["lossless"],
				playableState: "playable",
			},
			{
				provider: "netease",
				id: "song-2",
				sourceId: "song-2",
				title: "Second Song",
				artists: [],
				album: "Second Album",
				coverUrl: "",
				qualityHints: [],
				playableState: "vip_required",
			},
		],
	};
}

function resetPlaybackStore(): void {
	usePlaybackStore.setState({
		currentTrack: null,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		mode: "queue",
		queue: [],
	});
}

test("mapPlaylistDetailToShelfRows maps shared tracks into visual shelf detail rows and preserves playback metadata", () => {
	expect(mapPlaylistDetailToShelfRows(makeDetail(), "netease")).toEqual([
		{
			id: "song-1",
			name: "First Song",
			artist: "Alice / Bob",
			cover: "https://example.invalid/first.jpg",
			provider: "netease",
			type: "playable",
			sourceId: "song-1",
			title: "First Song",
			artists: ["Alice", "Bob"],
			album: "First Album",
			coverUrl: "https://example.invalid/first.jpg",
			durationMs: 201_000,
			playableState: "playable",
			qualityHints: ["lossless"],
		},
		{
			id: "song-2",
			name: "Second Song",
			artist: "Second Album",
			cover: "",
			provider: "netease",
			type: "vip_required",
			sourceId: "song-2",
			title: "Second Song",
			artists: [],
			album: "Second Album",
			coverUrl: "",
			playableState: "vip_required",
			qualityHints: [],
		},
	]);
});

test("mapShelfDetailRowToTrack returns a valid shared track for a loaded playable row", () => {
	const row = mapPlaylistDetailToShelfRows(makeDetail(), "netease")[0]!;
	expect(mapShelfDetailRowToTrack(row)).toEqual({
		provider: "netease",
		id: "song-1",
		sourceId: "song-1",
		title: "First Song",
		artists: ["Alice", "Bob"],
		album: "First Album",
		coverUrl: "https://example.invalid/first.jpg",
		durationMs: 201_000,
		qualityHints: ["lossless"],
		playableState: "playable",
	});
});

test("mapShelfDetailRowToTrack returns null for invalid provider, id, and title metadata", () => {
	expect(mapShelfDetailRowToTrack({ id: "song-1", name: "Song", provider: "unknown" })).toBeNull();
	expect(mapShelfDetailRowToTrack({ id: "", name: "Song", provider: "netease" })).toBeNull();
	expect(mapShelfDetailRowToTrack({ id: "song-1", name: "", provider: "netease" })).toBeNull();
});

test("mapPodcastItemsToShelfRows maps voice programs to playable rows and radios to inert drill-down rows", () => {
	const voiceItems: PodcastMyItemsResponse = {
		loggedIn: true,
		key: "liked",
		title: "喜欢的声音",
		sub: "",
		itemType: "voice",
		count: 1,
		coverUrl: "",
		items: [{
			type: "podcast",
			provider: "netease",
			id: "song-1",
			sourceId: "song-1",
			title: "声音",
			artists: ["主播"],
			album: "播客",
			coverUrl: "https://example.invalid/voice.jpg",
			durationMs: 120000,
			qualityHints: ["standard"],
			playableState: "unknown",
			programId: "program-1",
			radioId: "radio-1",
			radioName: "电台",
			djName: "",
			description: "",
			createTime: 0,
			serialNum: 0,
		}],
	};
	const radioItems: PodcastMyItemsResponse = {
		loggedIn: true,
		key: "collect",
		title: "收藏播客",
		sub: "",
		itemType: "radio",
		count: 1,
		coverUrl: "",
		items: [{
			id: "radio-1",
			rid: "radio-1",
			name: "电台",
			coverUrl: "https://example.invalid/radio.jpg",
			description: "",
			djName: "主播",
			category: "",
			programCount: 12,
			subCount: 0,
		}],
	};

	expect(mapPodcastItemsToShelfRows(voiceItems)).toEqual([{
		id: "song-1",
		name: "声音",
		artist: "主播",
		cover: "https://example.invalid/voice.jpg",
		provider: "netease",
		type: "unknown",
		sourceId: "song-1",
		title: "声音",
		artists: ["主播"],
		album: "播客",
		coverUrl: "https://example.invalid/voice.jpg",
		durationMs: 120000,
		playableState: "unknown",
		qualityHints: ["standard"],
	}]);
	expect(mapPodcastItemsToShelfRows(radioItems)).toEqual([{
		id: "radio-1",
		name: "电台",
		artist: "主播 · 12 集",
		cover: "https://example.invalid/radio.jpg",
		provider: "netease",
		type: "podcast-radio",
		sourceId: "radio-1",
		title: "电台",
		artists: ["主播"],
		album: "Podcast",
		coverUrl: "https://example.invalid/radio.jpg",
		playableState: "unavailable",
		qualityHints: [],
	}]);
});

test("playShelfDetailRow enqueues and plays valid rows while ignoring hard non-playable rows", () => {
	resetPlaybackStore();
	const rows = mapPlaylistDetailToShelfRows(makeDetail(), "netease");
	expect(playShelfDetailRow({ row: rows[0]!, index: 0 })).toBe(true);
	expect(usePlaybackStore.getState().queue.length).toBe(1);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("song-1");

	expect(playShelfDetailRow({ row: rows[1]!, index: 1 })).toBe(false);
	expect(usePlaybackStore.getState().queue.length).toBe(1);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("song-1");
});

test("handleShelfDetailRowAction plays the whole detail list from the clicked playable row", async () => {
	resetPlaybackStore();
	const rows = mapPlaylistDetailToShelfRows({
		...makeDetail(),
		tracks: [
			...makeDetail().tracks,
			{
				provider: "qq",
				id: "song-3",
				sourceId: "song-3",
				title: "Third Song",
				artists: ["Carol"],
				album: "Third Album",
				coverUrl: "https://example.invalid/third.jpg",
				qualityHints: ["standard"],
				playableState: "playable",
			},
		],
	}, "netease");

	expect(await handleShelfDetailRowAction({ row: rows[2]!, rows, index: 2, action: "play" })).toBe(true);
	expect(usePlaybackStore.getState().queue.map((track) => track.id)).toEqual(["song-1", "song-3"]);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("song-3");

	resetPlaybackStore();
	expect(await handleShelfDetailRowAction({ row: rows[0]!, rows, index: 0, action: "row" })).toBe(true);
	expect(usePlaybackStore.getState().queue.map((track) => track.id)).toEqual(["song-1", "song-3"]);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("song-1");
});

test("handleShelfDetailRowAction starts from the clicked duplicate detail row index", async () => {
	resetPlaybackStore();
	const rows = mapPlaylistDetailToShelfRows({
		...makeDetail(),
		tracks: [
			{
				provider: "netease",
				id: "same-song",
				sourceId: "same-source",
				title: "Duplicate Song",
				artists: ["Alice"],
				album: "First",
				coverUrl: "https://example.invalid/first.jpg",
				qualityHints: ["standard"],
				playableState: "playable",
			},
			{
				provider: "netease",
				id: "same-song",
				sourceId: "same-source",
				title: "Duplicate Song",
				artists: ["Alice"],
				album: "Second",
				coverUrl: "https://example.invalid/second.jpg",
				qualityHints: ["standard"],
				playableState: "playable",
			},
		],
	}, "netease");

	expect(await handleShelfDetailRowAction({ row: rows[1]!, rows, index: 1, action: "row" })).toBe(true);
	expect(usePlaybackStore.getState().queue.map((track) => track.album)).toEqual(["First", "Second"]);
	expect(usePlaybackStore.getState().currentTrack?.album).toBe("Second");
	usePlaybackStore.getState().setMode("loop");
	usePlaybackStore.getState().next();
	expect(usePlaybackStore.getState().currentTrack?.album).toBe("First");
});

test("handleShelfDetailRowAction inserts next rows after the current track without interrupting playback", async () => {
	resetPlaybackStore();
	const rows = mapPlaylistDetailToShelfRows(makeDetail(), "netease");
	const current = mapShelfDetailRowToTrack(rows[0]!)!;
	usePlaybackStore.getState().setQueue([current]);
	usePlaybackStore.getState().playAt(0);

	expect(await handleShelfDetailRowAction({ row: rows[1]!, index: 1, action: "next" })).toBe(false);
	expect(usePlaybackStore.getState().queue.map((track) => track.id)).toEqual(["song-1"]);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("song-1");

	expect(await handleShelfDetailRowAction({ row: rows[0]!, index: 0, action: "next" })).toBe(true);
	expect(usePlaybackStore.getState().queue.map((track) => track.id)).toEqual(["song-1"]);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("song-1");
});

test("handleShelfDetailRowAction plays explicit play and default row actions through search-result playback", async () => {
	resetPlaybackStore();
	const row = mapPlaylistDetailToShelfRows(makeDetail(), "netease")[0]!;

	expect(await handleShelfDetailRowAction({ row, index: 0, action: "play" })).toBe(true);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("song-1");
	expect(usePlaybackStore.getState().queue.map((track) => track.id)).toEqual(["song-1"]);

	resetPlaybackStore();
	expect(await handleShelfDetailRowAction({ row, index: 0, action: "row" })).toBe(true);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("song-1");
});

test("handleShelfDetailRowAction routes Netease like action through provider mutation without changing playback", async () => {
	resetPlaybackStore();
	const row = mapPlaylistDetailToShelfRows(makeDetail(), "netease")[0]!;
	const calls: unknown[] = [];

	expect(await handleShelfDetailRowAction({
		row,
		index: 0,
		action: "like",
		likes: {
			async likeSong(provider, id, liked) {
				calls.push({ provider, id, liked });
				return { provider, id, liked, code: 200 };
			},
		},
		isLiked: () => false,
	})).toBe(true);

	expect(calls).toEqual([{ provider: "netease", id: "song-1", liked: true }]);
	expect(usePlaybackStore.getState().queue).toEqual([]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
});

test("handleShelfDetailRowAction routes Soda like action through provider mutation", async () => {
	resetPlaybackStore();
	const sodaDetail: PlaylistDetail = {
		...makeDetail(),
		provider: "soda",
		tracks: makeDetail().tracks.map((track) => ({ ...track, provider: "soda" })),
	};
	const row = mapPlaylistDetailToShelfRows(sodaDetail, "soda")[0]!;
	const calls: unknown[] = [];

	expect(await handleShelfDetailRowAction({
		row,
		index: 0,
		action: "like",
		likes: {
			async likeSong(provider, id, liked) {
				calls.push({ provider, id, liked });
				return { provider, id, liked, code: 200 };
			},
		},
		isLiked: () => false,
	})).toBe(true);

	expect(calls).toEqual([{ provider: "soda", id: "song-1", liked: true }]);
	expect(usePlaybackStore.getState().queue).toEqual([]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
});

test("handleShelfDetailRowAction blocks import-only like actions before provider mutation", async () => {
	resetPlaybackStore();
	const row = {
		...mapPlaylistDetailToShelfRows(makeDetail(), "netease")[0]!,
		id: "import:apple-music:1",
		sourceId: "import:apple-music:1",
		name: "Imported Song",
		title: "Imported Song",
		playableState: "unknown",
	};
	const calls: unknown[] = [];
	const messages: string[] = [];

	expect(await handleShelfDetailRowAction({
		row,
		index: 0,
		action: "like",
		likes: {
			async likeSong(provider, id, liked) {
				calls.push({ provider, id, liked });
				return { provider, id, liked, code: 200 };
			},
		},
		isLiked: () => false,
		onResult: (message) => messages.push(message),
	})).toBe(false);

	expect(calls).toEqual([]);
	expect(messages).toEqual(["导入曲目暂不支持红心同步"]);
	expect(usePlaybackStore.getState().queue).toEqual([]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
});

test("handleShelfDetailRowAction allows baseline like action on hard non-playable cloud rows", async () => {
	resetPlaybackStore();
	const row = mapPlaylistDetailToShelfRows(makeDetail(), "netease")[1]!;
	const calls: unknown[] = [];

	expect(await handleShelfDetailRowAction({
		row,
		index: 1,
		action: "like",
		likes: {
			async likeSong(provider, id, liked) {
				calls.push({ provider, id, liked });
				return { provider, id, liked, code: 200 };
			},
		},
		isLiked: () => true,
	})).toBe(true);

	expect(calls).toEqual([{ provider: "netease", id: "song-2", liked: false }]);
	expect(usePlaybackStore.getState().queue).toEqual([]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
});

test("handleShelfDetailRowAction opens the baseline collect picker without direct playlist mutation", async () => {
	resetPlaybackStore();
	const row = mapPlaylistDetailToShelfRows(makeDetail(), "netease")[0]!;
	const opened: unknown[] = [];

	expect(await handleShelfDetailRowAction({
		row,
		index: 0,
		action: "collect",
		onOpenCollect: (track) => opened.push(track),
	})).toBe(true);
	expect(opened).toEqual([mapShelfDetailRowToTrack(row)]);
	expect(usePlaybackStore.getState().queue).toEqual([]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
});

test("handleShelfDetailRowAction blocks import-only collect actions before opening picker", async () => {
	resetPlaybackStore();
	const row = {
		...mapPlaylistDetailToShelfRows(makeDetail(), "netease")[0]!,
		id: "import:apple-music:1",
		sourceId: "import:apple-music:1",
		name: "Imported Song",
		title: "Imported Song",
		playableState: "unknown",
	};
	const opened: unknown[] = [];
	const messages: string[] = [];

	expect(await handleShelfDetailRowAction({
		row,
		index: 0,
		action: "collect",
		onOpenCollect: (track) => opened.push(track),
		onResult: (message) => messages.push(message),
	})).toBe(false);
	expect(opened).toEqual([]);
	expect(messages).toEqual(["导入曲目暂不支持收藏到歌单"]);
	expect(usePlaybackStore.getState().queue).toEqual([]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
});

test("handleShelfDetailRowAction opens podcast radio programs instead of playing radio placeholder rows", async () => {
	resetPlaybackStore();
	const row = mapPodcastItemsToShelfRows({
		loggedIn: true,
		key: "collect",
		title: "收藏播客",
		sub: "",
		itemType: "radio",
		count: 1,
		coverUrl: "",
		items: [{
			id: "radio-1",
			rid: "radio-1",
			name: "电台",
			coverUrl: "",
			description: "",
			djName: "主播",
			category: "",
			programCount: 12,
			subCount: 0,
		}],
	})[0]!;
	const opened: unknown[] = [];

	expect(await handleShelfDetailRowAction({
		row,
		index: 0,
		action: "play",
		onOpenPodcastRadio: (radioId, title) => opened.push({ radioId, title }),
	})).toBe(true);

	expect(opened).toEqual([{ radioId: "radio-1", title: "电台" }]);
	expect(usePlaybackStore.getState().queue).toEqual([]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
});

test("createShelfDetailContentLoader fetches playlist detail and writes rows through the request token", async () => {
	const calls: Array<{ provider: ProviderId; id: string }> = [];
	const writes: unknown[] = [];
	const loader = createShelfDetailContentLoader({
		library: {
			async playlistDetail(provider: ProviderId, id: string) {
				calls.push({ provider, id });
				return makeDetail();
			},
		},
		discover: null,
		search: null,
		getContentList: () => ({
			setRowsForToken(token: number, rows: unknown[], kind?: string) {
				writes.push({ token, rows, kind });
			},
			setErrorForToken() {
				throw new Error("should not set error on success");
			},
		}),
	});

	await loader({
		provider: "netease",
		playlistId: "daily",
		title: "Daily Mix",
		contentKind: "playlist",
		requestToken: 7,
		sourceCard: null,
	});

	expect(calls).toEqual([{ provider: "netease", id: "daily" }]);
	expect(writes).toEqual([{
		token: 7,
		kind: "playlist",
		rows: mapPlaylistDetailToShelfRows(makeDetail(), "netease"),
	}]);
});

test("createShelfDetailContentLoader fetches podcast collection detail through podcast API", async () => {
	const calls: unknown[] = [];
	const writes: unknown[] = [];
	const result: PodcastMyItemsResponse = {
		loggedIn: true,
		key: "liked",
		title: "喜欢的声音",
		sub: "",
		itemType: "voice",
		count: 1,
		coverUrl: "",
		items: [{
			type: "podcast",
			provider: "netease",
			id: "song-1",
			sourceId: "song-1",
			title: "声音",
			artists: ["主播"],
			album: "播客",
			coverUrl: "",
			qualityHints: [],
			playableState: "unknown",
			programId: "",
			radioId: "",
			radioName: "",
			djName: "",
			description: "",
			createTime: 0,
			serialNum: 0,
		}],
	};
	const loader = createShelfDetailContentLoader({
		library: null,
		discover: {
			async podcastMyItems(key, limit, offset) {
				calls.push({ key, limit, offset });
				return result;
			},
		},
		search: null,
		getContentList: () => ({
			setRowsForToken(token: number, rows: unknown[], kind?: string) {
				writes.push({ token, rows, kind });
			},
			setErrorForToken() {
				throw new Error("should not set error on success");
			},
		}),
	});

	await loader({
		playlistId: "podcast:liked",
		title: "喜欢的声音",
		contentKind: "podcast",
		requestToken: 8,
		sourceCard: null,
	});

	expect(calls).toEqual([{ key: "liked", limit: 36, offset: 0 }]);
	expect(writes).toEqual([{ token: 8, rows: mapPodcastItemsToShelfRows(result), kind: "podcast" }]);
});

test("createShelfDetailContentLoader fetches podcast radio programs through podcast API", async () => {
	const calls: unknown[] = [];
	const writes: unknown[] = [];
	const result: PodcastProgramsResponse = {
		radio: { id: "radio-1", rid: "radio-1", name: "电台" },
		programs: [{
			type: "podcast",
			provider: "netease",
			id: "song-1",
			sourceId: "song-1",
			title: "节目",
			artists: ["主播"],
			album: "电台",
			coverUrl: "",
			qualityHints: [],
			playableState: "unknown",
			programId: "",
			radioId: "radio-1",
			radioName: "电台",
			djName: "",
			description: "",
			createTime: 0,
			serialNum: 0,
		}],
		more: false,
		total: 1,
	};
	const loader = createShelfDetailContentLoader({
		library: null,
		discover: null,
		search: {
			async podcastPrograms(id, limit, offset) {
				calls.push({ id, limit, offset });
				return result;
			},
		},
		getContentList: () => ({
			setRowsForToken(token: number, rows: unknown[], kind?: string) {
				writes.push({ token, rows, kind });
			},
			setErrorForToken() {
				throw new Error("should not set error on success");
			},
		}),
	});

	await loader({
		playlistId: "podcast-radio:radio-1",
		title: "电台",
		contentKind: "podcast",
		requestToken: 10,
		sourceCard: null,
	});

	expect(calls).toEqual([{ id: "radio-1", limit: 36, offset: 0 }]);
	expect(writes).toEqual([{ token: 10, rows: mapPodcastItemsToShelfRows(result), kind: "podcast" }]);
});

test("createPodcastRadioDetailOpener reopens the active detail list and loads with the returned token", async () => {
	const opens: unknown[] = [];
	const loads: unknown[] = [];
	const opener = createPodcastRadioDetailOpener({
		getContentList: () => ({
			open(opts: unknown) {
				opens.push(opts);
				return 23;
			},
			setRowsForToken() {},
			setErrorForToken() {},
		}),
		load: async (payload) => {
			loads.push(payload);
		},
	});

	opener("radio-1", "电台");
	await Promise.resolve();

	expect(opens).toEqual([{
		playlistId: "podcast-radio:radio-1",
		title: "电台",
		kind: "podcast",
		sourceCard: null,
	}]);
	expect(loads).toEqual([{
		playlistId: "podcast-radio:radio-1",
		title: "电台",
		contentKind: "podcast",
		requestToken: 23,
		sourceCard: null,
	}]);
});

test("createShelfDetailContentLoader writes deterministic token-guarded errors when metadata is missing", async () => {
	const errors: unknown[] = [];
	const loader = createShelfDetailContentLoader({
		library: {
			async playlistDetail() {
				throw new Error("should not fetch without provider and playlist id");
			},
		},
		discover: null,
		search: null,
		getContentList: () => ({
			setRowsForToken() {
				throw new Error("should not set rows without metadata");
			},
			setErrorForToken(token: number, label: string) {
				errors.push({ token, label });
			},
		}),
	});

	await loader({
		playlistId: "",
		title: "Missing",
		contentKind: "playlist",
		requestToken: 3,
		sourceCard: null,
	});

	expect(errors).toEqual([{ token: 3, label: "歌单信息不完整" }]);
});

test("createShelfDetailContentLoader rejects unknown provider ids before native API fetch", async () => {
	const errors: unknown[] = [];
	const loader = createShelfDetailContentLoader({
		library: {
			async playlistDetail() {
				throw new Error("should not fetch invalid provider ids");
			},
		},
		discover: null,
		search: null,
		getContentList: () => ({
			setRowsForToken() {
				throw new Error("should not set rows without a valid provider");
			},
			setErrorForToken(token: number, label: string) {
				errors.push({ token, label });
			},
		}),
	});

	await loader({
		provider: "unknown",
		playlistId: "daily",
		title: "Invalid",
		contentKind: "playlist",
		requestToken: 4,
		sourceCard: null,
	});

	expect(errors).toEqual([{ token: 4, label: "歌单信息不完整" }]);
});

test("createShelfDetailContentLoader writes a safe token-guarded error label on fetch failure", async () => {
	const errors: unknown[] = [];
	const loader = createShelfDetailContentLoader({
		library: {
			async playlistDetail() {
				throw new Error("cookie=secret failed");
			},
		},
		discover: null,
		search: null,
		getContentList: () => ({
			setRowsForToken() {
				throw new Error("should not set rows on failure");
			},
			setErrorForToken(token: number, label: string) {
				errors.push({ token, label });
			},
		}),
	});

	await loader({
		provider: "netease",
		playlistId: "daily",
		title: "Daily Mix",
		contentKind: "playlist",
		requestToken: 9,
		sourceCard: null,
	});

	expect(errors).toEqual([{ token: 9, label: "歌单加载失败" }]);
});
