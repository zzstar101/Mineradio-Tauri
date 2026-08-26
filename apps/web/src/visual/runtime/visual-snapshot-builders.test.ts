import { expect, test } from "bun:test";
import { cloneFxState, type AudioFrameBytes } from "@mineradio/visual-engine";
import {
	buildLyricsVisualSnapshot,
	buildPlaybackVisualSnapshot,
	buildShelfVisualSnapshot,
	buildVisualSettingsSnapshot,
	createVisualMediaClock,
} from "./visual-snapshot-builders";

test("visual snapshot builders create complete immutable snapshots while preserving opaque runtime references", () => {
	const beatMap = { cameraBeats: [{ time: 1.25 }] };
	const backgroundMedia = { kind: "video", element: {} };
	const sourceFx = cloneFxState();
	sourceFx.preset = 6;
	sourceFx.performanceBackground = "keep";
	sourceFx.backgroundMedia = backgroundMedia;
	sourceFx.mouseXy = { x: 0.25, y: -0.5 };

	const playback = buildPlaybackVisualSnapshot({
		trackKey: "netease:42",
		title: "晴天",
		artist: "周杰伦",
		playing: true,
		durationMs: 210_000,
		coverUrl: "mineradio-image://cover/session-token/track-42",
		coverFallbackUrl: "https://img.example/a.jpg",
		beatMapKey: "netease:42",
		beatMap,
		splashActive: false,
		homeActive: true,
	});
	const lyrics = buildLyricsVisualSnapshot({
		lines: [{
			t: 1,
			text: "你好",
			translation: "Hello",
			duration: 2,
			charCount: 2,
			words: [{ text: "你", t: 1, d: 0.5, c0: 0, c1: 1 }],
		}],
		fallbackText: "Song - Artist",
		hasNativeKaraoke: true,
	});
	const shelf = buildShelfVisualSnapshot({
		items: [{ type: "playlist", title: "A", cover: "proxy-a.jpg", playlistId: "7", provider: "netease" }],
		pane: "fav",
		mode: "stage",
		cameraMode: "dynamic",
		presence: "auto",
		mergeCollections: true,
		mineCount: 3,
		favCount: 4,
		secondaryLeftDisplaySeamGuard: true,
	});
	const settings = buildVisualSettingsSnapshot({
		fxDefaults: { intensity: 0.7, performanceBackground: "keep" },
		fxState: sourceFx,
		coverResolution: 1.8,
		wallpaperSafe: false,
		prefersReducedMotion: true,
	});

	expect(playback.beatMap).toBe(beatMap);
	expect(playback).toEqual({
		trackKey: "netease:42",
		title: "晴天",
		artist: "周杰伦",
		playing: true,
		durationMs: 210_000,
		coverUrl: "mineradio-image://cover/session-token/track-42",
		coverFallbackUrl: "https://img.example/a.jpg",
		beatMapKey: "netease:42",
		beatMap,
		splashActive: false,
		homeActive: true,
	});
	expect(lyrics.lines).toEqual([{
		t: 1,
		text: "你好",
		translation: "Hello",
		duration: 2,
		charCount: 2,
		words: [{ text: "你", t: 1, d: 0.5, c0: 0, c1: 1 }],
	}]);
	expect(shelf).toEqual({
		items: [{ type: "playlist", title: "A", cover: "proxy-a.jpg", playlistId: "7", provider: "netease" }],
		pane: "fav",
		mode: "stage",
		cameraMode: "dynamic",
		presence: "auto",
		mergeCollections: true,
		mineCount: 3,
		favCount: 4,
		secondaryLeftDisplaySeamGuard: true,
	});
	expect(settings.fx).toEqual({ ...sourceFx, mouseXy: { x: 0.25, y: -0.5 } });
	expect(settings.fx.backgroundMedia).toBe(backgroundMedia);
	expect(settings.fx.preset).toBe(6);
	expect(settings.backgroundPolicy).toBe("keep");
	expect(settings.foregroundFramePolicy).toEqual({ mode: "vsync" });
	expect(settings.coverResolution).toBe(1.8);

	expect(Object.isFrozen(playback)).toBe(true);
	expect(Object.isFrozen(lyrics)).toBe(true);
	expect(Object.isFrozen(lyrics.lines)).toBe(true);
	expect(Object.isFrozen(lyrics.lines[0])).toBe(true);
	expect(lyrics.lines[0]?.translation).toBe("Hello");
	expect(Object.isFrozen(lyrics.lines[0]?.words)).toBe(true);
	expect(Object.isFrozen(shelf)).toBe(true);
	expect(Object.isFrozen(shelf.items)).toBe(true);
	expect(Object.isFrozen(shelf.items[0])).toBe(true);
	expect(Object.isFrozen(settings)).toBe(true);
	expect(Object.isFrozen(settings.fx)).toBe(true);
	expect(Object.isFrozen(settings.fx.mouseXy)).toBe(true);
});

function buildSettingsForPolicy(performanceQuality: string, prefersReducedMotion = false) {
	return buildVisualSettingsSnapshot({
		fxState: { performanceQuality },
		coverResolution: 1.55,
		wallpaperSafe: false,
		prefersReducedMotion,
	});
}

test("eco quality bounds the foreground visual scheduler at 30fps", () => {
	expect(buildSettingsForPolicy("eco").foregroundFramePolicy).toEqual({ mode: "fixed", fps: 30 });
});

test("balanced quality bounds the foreground visual scheduler at 45fps", () => {
	expect(buildSettingsForPolicy("balanced").foregroundFramePolicy).toEqual({ mode: "fixed", fps: 45 });
});

test("high quality keeps the foreground visual scheduler on vsync", () => {
	expect(buildSettingsForPolicy("high").foregroundFramePolicy).toEqual({ mode: "vsync" });
});

test("ultra quality keeps the global foreground frame policy on vsync", () => {
	expect(buildSettingsForPolicy("ultra").foregroundFramePolicy).toEqual({ mode: "vsync" });
});

test("reduced motion remains independent from the selected foreground frame policy", () => {
	const settings = buildSettingsForPolicy("eco", true);
	expect(settings.prefersReducedMotion).toBe(true);
	expect(settings.foregroundFramePolicy).toEqual({ mode: "fixed", fps: 30 });
});

test("visual media clock prefers the read-only audio frame and falls back to React playback state", () => {
	const emptyBytes = new Uint8Array(0);
	let audioFrame: AudioFrameBytes | null = {
		mainFreqData: emptyBytes,
		mainTimeData: emptyBytes,
		mainSampleRate: 0,
		mainFftSize: 0,
		beatFreqData: emptyBytes,
		beatTimeData: emptyBytes,
		beatSampleRate: 0,
		beatFftSize: 0,
		currentTimeSeconds: 12.345,
		playing: true,
	};
	let positionMs = 10_000;
	let playback = buildPlaybackVisualSnapshot({
		trackKey: "track",
		playing: false,
		durationMs: 210_000,
		coverUrl: "",
		coverFallbackUrl: "",
		beatMapKey: "",
		beatMap: null,
		splashActive: false,
		homeActive: false,
	});
	const clock = createVisualMediaClock({
		getAudioFrame: () => audioFrame,
		getPositionMs: () => positionMs,
		getPlaybackSnapshot: () => playback,
	});

	expect(clock.currentTimeSeconds()).toBe(12.345);
	expect(clock.durationSeconds()).toBe(210);
	expect(clock.isPlaying()).toBe(true);

	audioFrame = { ...audioFrame, currentTimeSeconds: NaN };
	positionMs = 15_500;
	playback = buildPlaybackVisualSnapshot({ ...playback, playing: true });
	expect(clock.currentTimeSeconds()).toBe(15.5);
	expect(clock.durationSeconds()).toBe(210);
	expect(clock.isPlaying()).toBe(true);

	audioFrame = null;
	playback = buildPlaybackVisualSnapshot({ ...playback, playing: false, durationMs: null });
	expect(clock.currentTimeSeconds()).toBe(15.5);
	expect(clock.durationSeconds()).toBeNull();
	expect(clock.isPlaying()).toBe(false);
});

test("snapshot builder remains independent of providers, HTTP routes, and Sidecar configuration", async () => {
	const source = await fetch(new URL("./visual-snapshot-builders.ts", import.meta.url)).then((response) => response.text());
	expect(source).not.toContain("ProviderId");
	expect(source).not.toContain("image-proxy");
	expect(source).not.toContain("sidecarBaseUrl");
});
