import { expect, test } from "bun:test";
import {
	buildLocalLibraryLyricPayload,
	buildTrackFromDto,
	classifyLocalLibraryImportError,
	filterLocalLibraryAudioPaths,
	filterLocalLibraryCoverPaths,
	localImportBusyDecision,
	localLibraryTrackKey,
	parseLocalLibraryLyricLines,
	planLocalLibraryImportToasts,
	shouldAttachDroppedCover,
	LocalLibraryController,
	type LocalLibraryListResult,
	type LocalLibraryLyricResult,
	type LocalLibraryTrackDto,
} from "./local-library-controller";

function dto(overrides: Partial<LocalLibraryTrackDto> = {}): LocalLibraryTrackDto {
	return {
		type: "local",
		source: "local",
		provider: "local",
		id: `local:${overrides.localFileId ?? "aa".repeat(12)}`,
		localFileId: overrides.localFileId ?? "a".repeat(24),
	name: "My Song",
	artist: "Test Artist",
		album: "Test Album",
		duration: 3.4567,
		cover: "http://mineradio-local.localhost/cover/x",
		hasLyric: true,
		lyricSource: "lrc",
		...overrides,
	};
}

test("buildTrackFromDto mirrors the established session-local mapping style", () => {
	const track = buildTrackFromDto(dto());
	expect(track).toEqual({
		provider: "netease",
		id: dto().id,
		sourceId: dto().id,
		title: "My Song",
		artists: ["Test Artist"],
		album: "Test Album",
		coverUrl: "http://mineradio-local.localhost/cover/x",
		durationMs: Math.round(3.4567 * 1000),
		qualityHints: ["local"],
		playableState: "playable",
	});
});

test("buildTrackFromDto applies upstream fallbacks for missing metadata", () => {
	const track = buildTrackFromDto(dto({ name: null, title: null, artist: "", album: null, cover: null, duration: 0 }));
	expect(track.title).toBe("本地文件");
	expect(track.artists).toEqual(["本地文件"]);
	expect(track.album).toBe("");
	expect(track.coverUrl).toBe("");
	expect(track.durationMs).toEqual(undefined);
});

test("registry keys are provider:id and lookups resolve protocol URLs", () => {
	const controller = new LocalLibraryController();
	controller.registerTracks([dto()]);
	const key = localLibraryTrackKey({ provider: "netease", id: dto().id });
	expect(key).toBe(`netease:${dto().id}`);
	expect(controller.isLibraryTrackKey(key)).toBe(true);
	expect(controller.getLocalMeta(key)?.localFileId).toBe("a".repeat(24));
	expect(controller.getLocalMeta(key)?.hasLyric).toBe(true);
	const url = controller.getLocalAudioUrl(key);
	expect(url?.startsWith("http://mineradio-local.localhost/audio/")).toBe(true);
	expect(controller.isLibraryTrackKey("netease:local:missing")).toBe(false);
	expect(controller.getLocalAudioUrl("netease:local:missing")).toBeNull();
});

test("registerTracks prefers the wire localUrl when present", () => {
	const controller = new LocalLibraryController();
	controller.registerTracks([dto({ localUrl: "http://mineradio-local.localhost/audio/direct" })]);
	expect(controller.getLocalAudioUrl(`netease:${dto().id}`)).toBe(
		"http://mineradio-local.localhost/audio/direct",
	);
});

test("loadLyric caches payloads so repeat plays never refetch", async () => {
	let reads = 0;
	const controller = new LocalLibraryController({
		readLyric: async (): Promise<LocalLibraryLyricResult> => {
			reads += 1;
			return { ok: true, localFileId: "a".repeat(24), lyric: "[00:01.00]hello", lyricSource: "lrc" };
		},
	});
	controller.registerTracks([dto()]);
	const key = `netease:${dto().id}`;
	const guards = {
		expectedQueueKey: key,
		currentQueueKey: () => key,
		isCurrent: () => true,
	};
	const first = await controller.loadLyric(key, guards);
	expect(reads).toBe(1);
	expect(first.rejected).toBe(false);
	expect(first.payload?.lines[0]?.text).toBe("hello");
	const second = await controller.loadLyric(key, guards);
	expect(reads).toBe(1);
	expect(second.payload?.lines[0]?.text).toBe("hello");
});

test("loadLyric rejects stale responses on generation or queue-key mismatch", async () => {
	const makeController = () =>
		new LocalLibraryController({
			readLyric: async (): Promise<LocalLibraryLyricResult> => ({
				ok: true,
				localFileId: "x",
				lyric: "[00:01.00]late",
			}),
		});
	let generation = 0;
	let queueKey = "netease:local:b";
	const register = (controller: LocalLibraryController) =>
		controller.registerTracks([dto({ id: "local:b", localFileId: "b" })]);

	const freshController = makeController();
	register(freshController);
	const fresh = await freshController.loadLyric("netease:local:b", {
		expectedQueueKey: "netease:local:b",
		currentQueueKey: () => queueKey,
		isCurrent: () => generation === 0,
	});
	expect(fresh.rejected).toBe(false); // guards passed at resolve time

	generation += 1;
	const staleGenerationController = makeController();
	register(staleGenerationController);
	const staleGeneration = await staleGenerationController.loadLyric("netease:local:b", {
		expectedQueueKey: "netease:local:b",
		currentQueueKey: () => queueKey,
		isCurrent: () => generation === 0,
	});
	expect(staleGeneration.rejected).toBe(true);
	expect(staleGeneration.payload).toBeNull();

	generation = 0;
	queueKey = "netease:other";
	const staleQueueKeyController = makeController();
	register(staleQueueKeyController);
	const staleQueueKey = await staleQueueKeyController.loadLyric("netease:local:b", {
		expectedQueueKey: "netease:local:b",
		currentQueueKey: () => queueKey,
		isCurrent: () => generation === 0,
	});
	expect(staleQueueKey.rejected).toBe(true);
	expect(staleQueueKey.payload).toBeNull();
});

test("importViaDialog registers returned tracks and surfaces failures", async () => {
	const controller = new LocalLibraryController({
		importDialog: async (): Promise<LocalLibraryListResult> => ({
			ok: true,
			version: 3,
			count: 2,
			tracks: [dto(), dto({ id: "local:c", localFileId: "c", name: "Other" })],
			failures: [{ name: "broken.mp3", error: "DECODE_FAILED" }],
		}),
	});
	const outcome = await controller.importViaDialog(false);
	expect(outcome.ok).toBe(true);
	expect(outcome.tracks.map((track) => track.title)).toEqual(["My Song", "Other"]);
	expect(outcome.failures).toEqual([{ name: "broken.mp3", error: "DECODE_FAILED" }]);
	expect(controller.snapshotTracks().length).toBe(2);
});

test("hydrate snapshots the persistent library exactly once per call site contract", async () => {
	let lists = 0;
	const controller = new LocalLibraryController({
		list: async (): Promise<LocalLibraryListResult> => {
			lists += 1;
			return { ok: true, version: 1, count: 1, tracks: [dto()] };
		},
	});
	await controller.hydrate();
	expect(lists).toBe(1);
	expect(controller.isHydrated()).toBe(true);
});

test("classifyLocalLibraryImportError separates dismissed, empty and partial failure outcomes", () => {
	expect(classifyLocalLibraryImportError({ ok: false, error: "IMPORT_DIALOG_DISMISSED" })).toBe("silent");
	expect(classifyLocalLibraryImportError({ ok: false, error: "NO_SUPPORTED_LOCAL_AUDIO" })).toBe("info");
	expect(classifyLocalLibraryImportError({ ok: false, error: "IO_BOOM" })).toBe("info");
	expect(classifyLocalLibraryImportError({ ok: true, failures: [{ name: "x", error: "e" }] })).toBe("failure");
	expect(classifyLocalLibraryImportError({ ok: true })).toBe("silent");
});

test("drag-drop path helpers filter supported audio and image extensions", () => {
	const paths = [
		"C:\\Music\\a.mp3",
		"C:\\Music\\b.FLAC",
		"C:\\Music\\c.wav",
		"C:\\Music\\d.ogg",
		"C:\\Music\\e.m4a",
		"C:\\Music\\f.aac",
		"C:\\Music\\g.opus",
		"C:\\Music\\cover.JPG",
		"C:\\Music\\art.png",
		"C:\\Music\\notes.txt",
		"C:\\Music\\video.avi",
	];
	expect(filterLocalLibraryAudioPaths(paths)).toEqual([
		"C:\\Music\\a.mp3",
		"C:\\Music\\b.FLAC",
		"C:\\Music\\c.wav",
		"C:\\Music\\d.ogg",
		"C:\\Music\\e.m4a",
		"C:\\Music\\f.aac",
		"C:\\Music\\g.opus",
	]);
	expect(filterLocalLibraryCoverPaths(paths)).toEqual([
		"C:\\Music\\cover.JPG",
		"C:\\Music\\art.png",
	]);
});

test("cover association only applies to a single audio + single image drop", () => {
	expect(shouldAttachDroppedCover(["a.mp3"], ["cover.jpg"])).toBe(true);
	expect(shouldAttachDroppedCover(["a.mp3", "b.mp3"], ["cover.jpg"])).toBe(false);
	expect(shouldAttachDroppedCover(["a.mp3"], [])).toBe(false);
	expect(shouldAttachDroppedCover(["a.mp3"], ["one.jpg", "two.jpg"])).toBe(false);
});

test("busy guard rejects re-entry while an import is in flight", () => {
	expect(localImportBusyDecision(true)).toBe("reject");
	expect(localImportBusyDecision(false)).toBe("proceed");
});

test("toast planner emits success plus delayed partial-failure summary", () => {
	const plan = planLocalLibraryImportToasts({
		ok: true,
		error: null,
		tracks: [buildTrackFromDto(dto()), buildTrackFromDto(dto({ id: "local:c", localFileId: "c" }))],
		failures: [{ name: "broken.mp3", error: "DECODE_FAILED" }],
		metadataWarnings: [],
	});
	expect(plan).toEqual([
		{ delayMs: 0, text: "已导入 2 首本地音乐" },
		{ delayMs: 900, text: "有 1 个文件无法读取，其余歌曲已保存" },
	]);
	const single = planLocalLibraryImportToasts({
		ok: true,
		error: null,
		tracks: [buildTrackFromDto({ id: "local:s", localFileId: "s", name: "One" })],
		failures: [],
		metadataWarnings: [],
	});
	expect(single).toEqual([{ delayMs: 0, text: "One" }]);
	const emptyDialog = planLocalLibraryImportToasts({
		ok: false,
		error: "NO_SUPPORTED_LOCAL_AUDIO",
		tracks: [],
		failures: [],
		metadataWarnings: [],
	});
	expect(emptyDialog).toEqual([{ delayMs: 0, text: "没有找到支持的本地音频文件" }]);
	const dismissed = planLocalLibraryImportToasts({
		ok: false,
		error: "IMPORT_DIALOG_DISMISSED",
		tracks: [],
		failures: [],
		metadataWarnings: [],
	});
	expect(dismissed).toEqual([]);
	const allFailed = planLocalLibraryImportToasts({
		ok: true,
		error: null,
		tracks: [],
		failures: [{ name: "a.mp3", error: "x" }, { name: "b.flac", error: "y" }],
		metadataWarnings: [],
	});
	expect(allFailed).toEqual([{ delayMs: 0, text: "有 2 个文件无法读取" }]);
});

test("parseLocalLibraryLyricLines parses LRC timestamps into payload lines", () => {
	const lines = parseLocalLibraryLyricLines("[00:01.50]first\n[01:02]second\nno tag line");
	expect(lines.map((line) => line.timeMs)).toEqual([1500, 62_000]);
	expect(lines[0]?.text).toBe("first");
	expect(lines[0]?.source).toBe("local-library");
	const track = buildTrackFromDto(dto());
	const payload = buildLocalLibraryLyricPayload(track, lines);
	expect(payload.provider).toBe("netease");
	expect(payload.trackId).toBe(track.id);
	expect(payload.hasTranslation).toBe(false);
});
